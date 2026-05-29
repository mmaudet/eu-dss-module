package com.linagora.eudss.server;

import com.linagora.eudss.server.dto.AssembleSignatureRequest;
import com.linagora.eudss.server.dto.AssembleSignatureResponse;
import com.linagora.eudss.server.dto.PrepareSignatureRequest;
import com.linagora.eudss.server.dto.PrepareSignatureResponse;
import com.linagora.eudss.server.dto.SignatureParamsDto;
import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.testutil.SamplePdf;
import com.linagora.eudss.server.testutil.TestPki;
import com.linagora.eudss.server.web.ValidationController;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.test.context.TestPropertySource;

import java.security.Signature;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = "eudss.lotl.enabled=false")
class SignatureE2ETest {

    @Autowired
    TestRestTemplate http;

    static TestPki.SelfSigned pki;
    static byte[] pdfBytes;

    @BeforeAll
    static void setup() throws Exception {
        pki = TestPki.generateSelfSignedRsa("eu-dss test signer");
        pdfBytes = SamplePdf.simpleA4WithText("Hello eu-dss");
    }

    @Test
    void sign_and_validate_pades_b() throws Exception {
        String pdfB64 = Base64.getEncoder().encodeToString(pdfBytes);
        String certB64 = Base64.getEncoder().encodeToString(pki.certificate().getEncoded());

        SignatureParamsDto params = new SignatureParamsDto(
                List.of(certB64),
                SignatureParamsDto.DigestAlgorithmDto.SHA256,
                System.currentTimeMillis(),
                SignatureParamsDto.SignatureLevelDto.BASELINE_B,
                "Test signing",
                "Paris",
                "eu-dss test signer"
        );

        PrepareSignatureResponse prepared = http.postForObject(
                "/api/sign/prepare",
                new PrepareSignatureRequest(pdfB64, "document.pdf", params),
                PrepareSignatureResponse.class
        );
        assertThat(prepared).isNotNull();
        assertThat(prepared.dataToSignBase64()).isNotBlank();

        byte[] dataToSign = Base64.getDecoder().decode(prepared.dataToSignBase64());
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(pki.privateKey());
        signer.update(dataToSign);
        byte[] signatureValue = signer.sign();

        AssembleSignatureResponse assembled = http.postForObject(
                "/api/sign/assemble",
                new AssembleSignatureRequest(pdfB64, "document.pdf", params, Base64.getEncoder().encodeToString(signatureValue)),
                AssembleSignatureResponse.class
        );
        assertThat(assembled).isNotNull();
        assertThat(assembled.signedDocumentBase64()).isNotBlank();
        assertThat(assembled.signedFileName()).isEqualTo("document.pdf");
        assertThat(assembled.mediaType()).contains("pdf");

        ValidationResponseDto validated = http.postForObject(
                "/api/validate",
                new ValidationController.ValidateRequest(assembled.signedDocumentBase64()),
                ValidationResponseDto.class
        );
        assertThat(validated).isNotNull();
        assertThat(validated.signatureCount()).isEqualTo(1);
        assertThat(validated.signatures()).hasSize(1);
        assertThat(validated.signatures().get(0).signatureFormat()).contains("PAdES-BASELINE-B");
        assertThat(validated.signatures().get(0).signedBy()).contains("eu-dss test signer");
    }

    @Test
    void co_signature_adds_a_second_independent_signature() throws Exception {
        String signedOnce = signPdfOnce(Base64.getEncoder().encodeToString(pdfBytes));
        String signedTwice = signPdfOnce(signedOnce);

        ValidationResponseDto validated = http.postForObject(
                "/api/validate",
                new ValidationController.ValidateRequest(signedTwice),
                ValidationResponseDto.class);
        assertThat(validated.signatureCount()).isEqualTo(2);
    }

    /** Runs prepare -> sign-with-TestPki -> assemble for a base64 PDF, returns the signed PDF base64. */
    private String signPdfOnce(String pdfB64) throws Exception {
        String certB64 = Base64.getEncoder().encodeToString(pki.certificate().getEncoded());
        SignatureParamsDto params = new SignatureParamsDto(
                List.of(certB64),
                SignatureParamsDto.DigestAlgorithmDto.SHA256,
                System.currentTimeMillis(),
                SignatureParamsDto.SignatureLevelDto.BASELINE_B,
                "Co-sign test", "Paris", "eu-dss test signer");

        PrepareSignatureResponse prepared = http.postForObject(
                "/api/sign/prepare",
                new PrepareSignatureRequest(pdfB64, "document.pdf", params),
                PrepareSignatureResponse.class);

        byte[] dataToSign = Base64.getDecoder().decode(prepared.dataToSignBase64());
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(pki.privateKey());
        signer.update(dataToSign);
        String signatureValueB64 = Base64.getEncoder().encodeToString(signer.sign());

        AssembleSignatureResponse assembled = http.postForObject(
                "/api/sign/assemble",
                new AssembleSignatureRequest(pdfB64, "document.pdf", params, signatureValueB64),
                AssembleSignatureResponse.class);
        return assembled.signedDocumentBase64();
    }
}
