package com.linagora.eudss.server.config;

import com.linagora.eudss.server.service.DocumentSigner;
import com.linagora.eudss.server.service.XadesSigningService;
import eu.europa.esig.dss.asic.xades.signature.ASiCWithXAdESService;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.pades.signature.PAdESService;
import eu.europa.esig.dss.xades.signature.XAdESService;
import eu.europa.esig.dss.service.crl.OnlineCRLSource;
import eu.europa.esig.dss.service.http.commons.CommonsDataLoader;
import eu.europa.esig.dss.service.http.commons.FileCacheDataLoader;
import eu.europa.esig.dss.service.http.commons.OCSPDataLoader;
import eu.europa.esig.dss.service.http.commons.TimestampDataLoader;
import eu.europa.esig.dss.service.ocsp.OnlineOCSPSource;
import eu.europa.esig.dss.service.tsp.OnlineTSPSource;
import eu.europa.esig.dss.spi.tsl.TrustedListsCertificateSource;
import eu.europa.esig.dss.spi.x509.KeyStoreCertificateSource;
import eu.europa.esig.dss.spi.x509.aia.DefaultAIASource;
import eu.europa.esig.dss.spi.x509.tsp.TSPSource;
import eu.europa.esig.dss.spi.validation.CommonCertificateVerifier;
import eu.europa.esig.dss.tsl.function.TLPredicateFactory;
import eu.europa.esig.dss.tsl.job.TLValidationJob;
import eu.europa.esig.dss.tsl.source.LOTLSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;

import java.io.File;

@Configuration
public class DssConfig {

    private static final Logger LOG = LoggerFactory.getLogger(DssConfig.class);

    private static final String LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml";
    private static final String OJ_KEYSTORE = "/lotl-keystore.p12";
    private static final char[] OJ_KEYSTORE_PWD = "dss-password".toCharArray();
    // ChamberSign is a French QTSP -> only the FR trusted list is needed (much faster than the full LOTL).
    private static final String[] TL_COUNTRIES = {"FR"};

    /** Retained after bean creation so the post-startup listener can trigger the refresh. */
    private TLValidationJob tlValidationJobRef;
    private boolean lotlEnabledFlag;

    @Bean
    public CommonsDataLoader commonsDataLoader() {
        return new CommonsDataLoader();
    }

    @Bean
    public TrustedListsCertificateSource trustedListsCertificateSource() {
        return new TrustedListsCertificateSource();
    }

    /**
     * Loads the EU List of Trusted Lists (filtered to FR) at startup so the validator can
     * recognise ChamberSign as a qualified trust service provider -> QES qualification.
     * Resilient: a refresh failure (offline) only degrades validation to INDETERMINATE.
     */
    @Bean
    public TLValidationJob tlValidationJob(CommonsDataLoader dataLoader,
                                           TrustedListsCertificateSource trustedListSource,
                                           @Value("${eudss.lotl.enabled:true}") boolean lotlEnabled) {
        TLValidationJob job = new TLValidationJob();
        job.setTrustedListCertificateSource(trustedListSource);

        FileCacheDataLoader onlineLoader = new FileCacheDataLoader();
        onlineLoader.setDataLoader(dataLoader);
        onlineLoader.setCacheExpirationTime(0);
        File cacheDir = new File(System.getProperty("java.io.tmpdir"), "dss-tl-cache");
        cacheDir.mkdirs();
        onlineLoader.setFileCacheDirectory(cacheDir);
        job.setOnlineDataLoader(onlineLoader);

        KeyStoreCertificateSource ojKeyStore = new KeyStoreCertificateSource(
                DssConfig.class.getResourceAsStream(OJ_KEYSTORE), "PKCS12", OJ_KEYSTORE_PWD);

        LOTLSource lotl = new LOTLSource();
        lotl.setUrl(LOTL_URL);
        lotl.setCertificateSource(ojKeyStore);
        lotl.setPivotSupport(true);
        lotl.setTlPredicate(TLPredicateFactory.createEUTLCountryCodePredicate(TL_COUNTRIES));
        job.setListOfTrustedListSources(lotl);

        // Store references for the post-startup background refresh (see refreshLotlAsync below).
        this.tlValidationJobRef = job;
        this.lotlEnabledFlag = lotlEnabled;

        if (!lotlEnabled) {
            LOG.info("eudss.lotl.enabled=false -> EU LOTL refresh disabled (validation stays INDETERMINATE)");
        }
        return job;
    }

    /**
     * Triggers the EU LOTL online refresh on a background thread AFTER the Spring context is
     * fully started (ApplicationReadyEvent), so the HTTP server (including /api/health) is
     * available immediately and does not block on the network fetch.
     * Graceful degradation: if the refresh fails the validator continues with INDETERMINATE results.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void refreshLotlAsync() {
        if (!lotlEnabledFlag) {
            return;
        }
        Thread t = new Thread(() -> {
            try {
                LOG.info("Background LOTL refresh started (countries={}) ...", (Object) TL_COUNTRIES);
                tlValidationJobRef.onlineRefresh();
                LOG.info("Background LOTL refresh complete.");
            } catch (Exception e) {
                LOG.warn("Background LOTL refresh failed: {} -> validation will be INDETERMINATE (no trust anchors)", e.toString());
            }
        }, "lotl-refresh");
        t.setDaemon(true);
        t.start();
    }

    @Bean
    public CommonCertificateVerifier certificateVerifier(CommonsDataLoader dataLoader,
                                                         TrustedListsCertificateSource trustedListSource) {
        CommonCertificateVerifier verifier = new CommonCertificateVerifier();
        verifier.setAIASource(new DefaultAIASource(dataLoader));     // complete the chain from the leaf-only token output
        verifier.setCrlSource(new OnlineCRLSource(dataLoader));      // revocation (CRL)
        OnlineOCSPSource ocspSource = new OnlineOCSPSource();
        ocspSource.setDataLoader(new OCSPDataLoader());
        verifier.setOcspSource(ocspSource);                          // revocation (OCSP)
        verifier.setTrustedCertSources(trustedListSource);           // EU trusted lists -> QES qualification
        // Revocation (and thus outbound OCSP/CRL fetches) is only performed for chains anchored in the
        // EU trust list, so a supplied untrusted signature can't drive arbitrary outbound requests.
        verifier.setCheckRevocationForUntrustedChains(false);
        return verifier;
    }

    @Bean
    public TSPSource tspSource(EudssProperties props) {
        TimestampDataLoader loader = new TimestampDataLoader();
        OnlineTSPSource source = new OnlineTSPSource(props.tsa().url());
        source.setDataLoader(loader);
        return source;
    }

    @Bean
    public PAdESService padesService(CommonCertificateVerifier verifier, TSPSource tspSource) {
        PAdESService service = new PAdESService(verifier);
        service.setTspSource(tspSource);
        return service;
    }

    @Bean
    public ASiCWithXAdESService asicWithXAdESService(CommonCertificateVerifier verifier, TSPSource tspSource) {
        ASiCWithXAdESService service = new ASiCWithXAdESService(verifier);
        service.setTspSource(tspSource);
        return service;
    }

    /** Standalone (non-ASiC) XAdES service, used for ENVELOPING XAdES signatures. */
    @Bean
    public XAdESService xadesService(CommonCertificateVerifier verifier, TSPSource tspSource) {
        XAdESService service = new XAdESService(verifier);
        service.setTspSource(tspSource);
        return service;
    }

    @Bean
    public DocumentSigner xadesEnvelopingSigningService(XAdESService xadesService) {
        return new XadesSigningService(xadesService, SignaturePackaging.ENVELOPING);
    }
}
