package com.linagora.eudss.server;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.dto.ValidationResponseDto.ValidationKind;
import com.linagora.eudss.server.service.DocumentValidationService;
import com.linagora.eudss.server.testutil.SamplePdf;
import com.linagora.eudss.server.testutil.TestPki;
import com.linagora.eudss.server.testutil.XadesFixtures;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.xades.signature.XAdESService;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@TestPropertySource(properties = "eudss.lotl.enabled=false")
class DocumentValidationServiceTest {

    @Autowired DocumentValidationService validation;
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
    void detached_without_source_asks_for_content() throws Exception {
        byte[] original = "the signed payload".getBytes(StandardCharsets.UTF_8);
        byte[] sig = XadesFixtures.xades(xadesService, pki, SignaturePackaging.DETACHED, original, "data.bin");

        ValidationResponseDto res = validation.validate(b64(sig), "data.xml", null, null);

        assertThat(res.kind()).isEqualTo(ValidationKind.DETACHED_CONTENT_REQUIRED);
    }

    @Test
    void detached_with_correct_source_validates() throws Exception {
        byte[] original = "the signed payload".getBytes(StandardCharsets.UTF_8);
        byte[] sig = XadesFixtures.xades(xadesService, pki, SignaturePackaging.DETACHED, original, "data.bin");

        ValidationResponseDto res = validation.validate(b64(sig), "data.xml", b64(original), "data.bin");

        assertThat(res.kind()).isEqualTo(ValidationKind.VALIDATED);
        assertThat(res.signatureCount()).isEqualTo(1);
        assertThat(res.signatures().get(0).signedBy()).contains("eu-dss test signer");
    }

    @Test
    void enveloping_is_self_contained() throws Exception {
        byte[] original = "embedded payload".getBytes(StandardCharsets.UTF_8);
        byte[] sig = XadesFixtures.xades(xadesService, pki, SignaturePackaging.ENVELOPING, original, "data.bin");

        ValidationResponseDto res = validation.validate(b64(sig), "data.xml", null, null);

        assertThat(res.kind()).isEqualTo(ValidationKind.VALIDATED);
        assertThat(res.signatureCount()).isEqualTo(1);
    }

    @Test
    void unsigned_pdf_is_not_a_signature() throws Exception {
        byte[] pdf = SamplePdf.simpleA4WithText("not signed");
        ValidationResponseDto res = validation.validate(b64(pdf), "plain.pdf", null, null);
        assertThat(res.kind()).isEqualTo(ValidationKind.NOT_A_SIGNATURE);
    }

    @Test
    void arbitrary_bytes_are_not_a_signature() {
        byte[] junk = "this is not a signature container".getBytes(StandardCharsets.UTF_8);
        ValidationResponseDto res = validation.validate(b64(junk), "data.bin", null, null);
        assertThat(res.kind()).isEqualTo(ValidationKind.NOT_A_SIGNATURE);
    }
}
