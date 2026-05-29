package com.linagora.eudss.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.linagora.eudss.agent.AgentMain;
import com.linagora.eudss.agent.config.AgentConfig;
import com.linagora.eudss.agent.dto.CertificateInfo;
import com.linagora.eudss.agent.service.TokenService;
import com.linagora.eudss.server.dto.AssembleSignatureRequest;
import com.linagora.eudss.server.dto.AssembleSignatureResponse;
import com.linagora.eudss.server.dto.PrepareSignatureRequest;
import com.linagora.eudss.server.dto.PrepareSignatureResponse;
import com.linagora.eudss.server.dto.SignatureParamsDto;
import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.testutil.SamplePdf;
import com.linagora.eudss.server.testutil.TestPki;
import com.linagora.eudss.server.web.ValidationController;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import io.javalin.Javalin;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.test.context.TestPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.Signature;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = "eudss.lotl.enabled=false")
class FullStackE2ETest {

    @Autowired
    TestRestTemplate http;

    static TestPki.SelfSigned pki;
    static Javalin agent;
    static int agentPort;
    static HttpClient agentClient;
    static ObjectMapper json;
    static byte[] pdfBytes;

    @BeforeAll
    static void boot() throws Exception {
        pki = TestPki.generateSelfSignedRsa("eu-dss full-stack test");
        pdfBytes = SamplePdf.simpleA4WithText("Hello full stack");
        json = new ObjectMapper();
        agentClient = HttpClient.newHttpClient();

        AgentConfig cfg = new AgentConfig(
                Path.of("/nonexistent/driver"),
                0,
                0,
                List.of("localhost"),
                "0000".toCharArray()
        );
        TokenService tokenStub = new TokenService(cfg) {
            @Override
            public List<CertificateInfo> listCertificates() {
                try {
                    String certB64 = Base64.getEncoder().encodeToString(pki.certificate().getEncoded());
                    return List.of(new CertificateInfo(
                            "test-key",
                            certB64,
                            List.of(certB64),
                            pki.certificate().getSubjectX500Principal().getName(),
                            pki.certificate().getIssuerX500Principal().getName(),
                            pki.certificate().getSerialNumber().toString(),
                            pki.certificate().getNotBefore().toInstant().toString(),
                            pki.certificate().getNotAfter().toInstant().toString()
                    ));
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            }

            @Override
            public byte[] signDigest(String keyId, byte[] digestBytes, DigestAlgorithm algorithm) {
                try {
                    Signature signer = Signature.getInstance("NONEwithRSA");
                    signer.initSign(pki.privateKey());
                    byte[] digestInfoPrefix = sha256DigestInfoPrefix();
                    byte[] payload = new byte[digestInfoPrefix.length + digestBytes.length];
                    System.arraycopy(digestInfoPrefix, 0, payload, 0, digestInfoPrefix.length);
                    System.arraycopy(digestBytes, 0, payload, digestInfoPrefix.length, digestBytes.length);
                    signer.update(payload);
                    return signer.sign();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            }
        };
        agent = AgentMain.buildApp(cfg, tokenStub).start(0);
        agentPort = agent.port();
    }

    @AfterAll
    static void shutdown() {
        if (agent != null) agent.stop();
    }

    @Test
    void full_e2e_sign_via_agent_and_validate_via_backend() throws Exception {
        Map<String, List<Map<String, Object>>> certsResponse = agentGet("/rest/certificates", new com.fasterxml.jackson.core.type.TypeReference<>() {});
        List<Map<String, Object>> certs = certsResponse.get("certificates");
        assertThat(certs).hasSize(1);
        Map<String, Object> cert = certs.get(0);
        String keyId = (String) cert.get("keyId");
        @SuppressWarnings("unchecked")
        List<String> chain = (List<String>) cert.get("certificateChainBase64");

        String pdfB64 = Base64.getEncoder().encodeToString(pdfBytes);
        SignatureParamsDto params = new SignatureParamsDto(
                chain,
                SignatureParamsDto.DigestAlgorithmDto.SHA256,
                System.currentTimeMillis(),
                SignatureParamsDto.SignatureLevelDto.BASELINE_B,
                "Full-stack test",
                "Paris",
                "eu-dss full-stack test"
        );

        PrepareSignatureResponse prepared = http.postForObject(
                "/api/sign/prepare",
                new PrepareSignatureRequest(pdfB64, "document.pdf", params),
                PrepareSignatureResponse.class
        );
        assertThat(prepared.dataToSignDigestBase64()).isNotBlank();

        Map<String, String> signRequest = Map.of(
                "keyId", keyId,
                "digestBase64", prepared.dataToSignDigestBase64(),
                "digestAlgorithm", "SHA256"
        );
        Map<String, String> signResponse = agentPost("/rest/sign", signRequest, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        String signatureValueB64 = signResponse.get("signatureValueBase64");
        assertThat(signatureValueB64).isNotBlank();

        AssembleSignatureResponse assembled = http.postForObject(
                "/api/sign/assemble",
                new AssembleSignatureRequest(pdfB64, "document.pdf", params, signatureValueB64),
                AssembleSignatureResponse.class
        );
        assertThat(assembled.signedDocumentBase64()).isNotBlank();

        ValidationResponseDto validated = http.postForObject(
                "/api/validate",
                new ValidationController.ValidateRequest(assembled.signedDocumentBase64()),
                ValidationResponseDto.class
        );
        assertThat(validated.signatureCount()).isEqualTo(1);
        assertThat(validated.signatures().get(0).signedBy()).contains("eu-dss full-stack test");
    }

    private <T> T agentGet(String path, com.fasterxml.jackson.core.type.TypeReference<T> typeRef) throws Exception {
        HttpResponse<String> res = agentClient.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + agentPort + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString()
        );
        return json.readValue(res.body(), typeRef);
    }

    private <T> T agentPost(String path, Object body, com.fasterxml.jackson.core.type.TypeReference<T> typeRef) throws Exception {
        HttpResponse<String> res = agentClient.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + agentPort + path))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
        return json.readValue(res.body(), typeRef);
    }

    private static byte[] sha256DigestInfoPrefix() {
        return new byte[]{
                0x30, 0x31,
                0x30, 0x0d,
                0x06, 0x09, 0x60, (byte) 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
                0x05, 0x00,
                0x04, 0x20
        };
    }
}
