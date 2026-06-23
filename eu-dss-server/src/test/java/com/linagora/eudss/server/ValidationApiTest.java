package com.linagora.eudss.server;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.dto.ValidationResponseDto.ValidationKind;
import com.linagora.eudss.server.testutil.TestPki;
import com.linagora.eudss.server.testutil.XadesFixtures;
import com.linagora.eudss.server.web.ValidationController;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.xades.signature.XAdESService;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.test.context.TestPropertySource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = "eudss.lotl.enabled=false")
class ValidationApiTest {

    @Autowired TestRestTemplate http;
    @Autowired XAdESService xadesService;

    static TestPki.SelfSigned pki;

    @BeforeAll
    static void setup() throws Exception {
        pki = TestPki.generateSelfSignedRsa("eu-dss test signer");
    }

    private static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    @Test
    void detached_signature_posted_alone_requests_content() throws Exception {
        byte[] original = "payload over http".getBytes(StandardCharsets.UTF_8);
        byte[] sig = XadesFixtures.xades(xadesService, pki, SignaturePackaging.DETACHED, original, "data.bin");

        ValidationResponseDto res = http.postForObject(
                "/api/validate",
                new ValidationController.ValidateRequest(b64(sig)),
                ValidationResponseDto.class);

        assertThat(res.kind()).isEqualTo(ValidationKind.DETACHED_CONTENT_REQUIRED);
    }

    @Test
    void detached_pair_posted_together_validates() throws Exception {
        byte[] original = "payload over http".getBytes(StandardCharsets.UTF_8);
        byte[] sig = XadesFixtures.xades(xadesService, pki, SignaturePackaging.DETACHED, original, "data.bin");

        ValidationResponseDto res = http.postForObject(
                "/api/validate",
                new ValidationController.ValidateRequest(b64(sig), "data.xml", b64(original), "data.bin"),
                ValidationResponseDto.class);

        assertThat(res.kind()).isEqualTo(ValidationKind.VALIDATED);
        assertThat(res.signatureCount()).isEqualTo(1);
    }
}
