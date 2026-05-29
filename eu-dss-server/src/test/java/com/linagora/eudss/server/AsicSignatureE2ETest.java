package com.linagora.eudss.server;

import com.linagora.eudss.server.dto.AssembleSignatureRequest;
import com.linagora.eudss.server.dto.AssembleSignatureResponse;
import com.linagora.eudss.server.dto.PrepareSignatureRequest;
import com.linagora.eudss.server.dto.PrepareSignatureResponse;
import com.linagora.eudss.server.dto.SignatureParamsDto;
import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.testutil.TestPki;
import com.linagora.eudss.server.web.ValidationController;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.test.context.TestPropertySource;

import java.nio.charset.StandardCharsets;
import java.security.Signature;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = "eudss.lotl.enabled=false")
class AsicSignatureE2ETest {

    @Autowired
    TestRestTemplate http;

    static TestPki.SelfSigned pki;

    @BeforeAll
    static void setup() throws Exception {
        pki = TestPki.generateSelfSignedRsa("eu-dss asic test signer");
    }

    @Test
    void sign_non_pdf_as_asic_and_validate() throws Exception {
        byte[] docxBytes = "fake office document content".getBytes(StandardCharsets.UTF_8);
        String docB64 = Base64.getEncoder().encodeToString(docxBytes);
        String certB64 = Base64.getEncoder().encodeToString(pki.certificate().getEncoded());

        SignatureParamsDto params = new SignatureParamsDto(
                List.of(certB64),
                SignatureParamsDto.DigestAlgorithmDto.SHA256,
                System.currentTimeMillis(),
                SignatureParamsDto.SignatureLevelDto.BASELINE_B,
                "ASiC test", "Paris", "eu-dss asic test signer"
        );

        PrepareSignatureResponse prepared = http.postForObject(
                "/api/sign/prepare",
                new PrepareSignatureRequest(docB64, "report.docx", params),
                PrepareSignatureResponse.class);
        assertThat(prepared.dataToSignBase64()).isNotBlank();

        byte[] dataToSign = Base64.getDecoder().decode(prepared.dataToSignBase64());
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(pki.privateKey());
        signer.update(dataToSign);
        String signatureValueB64 = Base64.getEncoder().encodeToString(signer.sign());

        AssembleSignatureResponse assembled = http.postForObject(
                "/api/sign/assemble",
                new AssembleSignatureRequest(docB64, "report.docx", params, signatureValueB64),
                AssembleSignatureResponse.class);
        assertThat(assembled.signedDocumentBase64()).isNotBlank();
        assertThat(assembled.signedFileName()).isEqualTo("report.asice");

        ValidationResponseDto validated = http.postForObject(
                "/api/validate",
                new ValidationController.ValidateRequest(assembled.signedDocumentBase64()),
                ValidationResponseDto.class);
        assertThat(validated.signatureCount()).isEqualTo(1);
        assertThat(validated.signatures().get(0).signatureFormat()).contains("XAdES");
        assertThat(validated.signatures().get(0).signedBy()).contains("eu-dss asic test signer");
    }
}
