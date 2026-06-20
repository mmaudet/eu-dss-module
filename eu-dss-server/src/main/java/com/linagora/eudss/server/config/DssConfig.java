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
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.File;

@Configuration
public class DssConfig {

    private static final Logger LOG = LoggerFactory.getLogger(DssConfig.class);

    private static final String LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml";
    private static final String OJ_KEYSTORE = "/lotl-keystore.p12";
    private static final char[] OJ_KEYSTORE_PWD = "dss-password".toCharArray();
    // ChamberSign is a French QTSP -> only the FR trusted list is needed (much faster than the full LOTL).
    private static final String[] TL_COUNTRIES = {"FR"};

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

        if (!lotlEnabled) {
            LOG.info("eudss.lotl.enabled=false -> skipping EU LOTL refresh (no trust anchors; validation stays INDETERMINATE)");
            return job;
        }
        try {
            LOG.info("Refreshing EU LOTL (countries={}) ...", (Object) TL_COUNTRIES);
            job.onlineRefresh();
            LOG.info("Trusted lists loaded: {} trusted certificates", trustedListSource.getCertificates().size());
        } catch (Exception e) {
            LOG.warn("LOTL refresh failed: {} -> validation will be INDETERMINATE (no trust anchors)", e.toString());
        }
        return job;
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

    /** Standalone (non-ASiC) XAdES service, used for ENVELOPING and DETACHED XAdES signatures. */
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

    @Bean
    public DocumentSigner xadesDetachedSigningService(XAdESService xadesService) {
        return new XadesSigningService(xadesService, SignaturePackaging.DETACHED);
    }
}
