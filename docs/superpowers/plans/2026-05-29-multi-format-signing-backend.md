# Multi-format document signing — Backend (A1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the eu-dss backend so it signs and validates **PDF (PAdES-B-T)** and **office/other files (docx, xlsx, ODF, …) as ASiC-E / XAdES-B-T**, keeping the proven 3-round-trip external-signing flow and an unchanged agent.

**Architecture:** A `DocumentSigningService` facade decodes the uploaded document, picks a `DocumentSigner` by file extension (PDF → existing PAdES path; everything else → new ASiC-with-XAdES path), and reuses one common digest + `SignatureValue` construction. Signature levels become format-agnostic (`BASELINE_B/T/LT/LTA`) and are mapped to PAdES or XAdES at signing time. Validation already auto-detects the container, so it only needs DTO renames.

**Tech Stack:** Java 21, Spring Boot 3.4, EU DSS 6.4 (`dss-pades-pdfbox`, **new** `dss-asic-xades`), Maven, JUnit 5 + AssertJ + Spring Boot Test (`@SpringBootTest(RANDOM_PORT)`), existing `TestPki`/`SamplePdf` test utils, stubbed PKCS#11 (no token needed in tests).

**Scope note:** This is plan **A1 (backend API)**. The **A2 (UI multi-document workspace)** is a separate plan written after A1 lands. Spec: `docs/superpowers/specs/2026-05-29-increment-a-multi-format-document-signing-design.md`.

**Conventions used throughout:**
- JDK 21 for all builds: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home`
- Build one module + deps: `mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-server -am`
- Tests already gate the LOTL download off via `@TestPropertySource(properties = "eudss.lotl.enabled=false")` on the `@SpringBootTest` classes — keep that on any new `@SpringBootTest`.
- If any DSS class/method name below does not resolve, verify the exact signature with:
  `javap -classpath "$(find ~/.m2/repository/eu/europa/ec/joinup/sd-dss -name '*-6.4.jar' | tr '\n' ':')" <fully.qualified.ClassName>`

---

## File Structure

**Backend (`eu-dss-server/src/main/java/com/linagora/eudss/server/`):**
- `dto/PrepareSignatureRequest.java` — MODIFY: `pdfBase64` → `documentBase64` + add `documentName`.
- `dto/AssembleSignatureRequest.java` — MODIFY: same rename + add `documentName`.
- `dto/AssembleSignatureResponse.java` — MODIFY: `signedPdfBase64` → `signedDocumentBase64` + add `signedFileName`, `mediaType`.
- `dto/SignatureParamsDto.java` — MODIFY: rename level enum values to format-agnostic `BASELINE_*`.
- `service/SignatureMapper.java` — MODIFY: split level mapping (PAdES + XAdES), add `toAsicParams`, add `firstCertificate`.
- `service/DocumentSigner.java` — CREATE: interface (`dataToSign`, `sign`).
- `service/SigningFormat.java` — CREATE: enum + extension detector.
- `service/PadesSigningService.java` — MODIFY: implement `DocumentSigner` (pure DSSDocument in/out; drop request decoding).
- `service/AsicSigningService.java` — CREATE: `DocumentSigner` for ASiC-E/XAdES.
- `service/DocumentSigningService.java` — CREATE: facade (`prepare`/`assemble`), format dispatch + common digest/SignatureValue.
- `service/PdfValidationService.java` → RENAME to `service/DocumentValidationService.java` — MODIFY: param name only (already container-agnostic).
- `web/SignatureController.java` — MODIFY: depend on `DocumentSigningService`.
- `web/ValidationController.java` — MODIFY: `ValidateRequest.pdfBase64` → `documentBase64`; depend on `DocumentValidationService`.
- `config/DssConfig.java` — MODIFY: add `ASiCWithXAdESService` bean.
- `eu-dss-server/pom.xml` — MODIFY: add `dss-asic-xades`.

**Tests (`eu-dss-server/src/test/java/com/linagora/eudss/server/`):**
- `SignatureE2ETest.java` — MODIFY: new DTO field names + enum; add a co-signature test method.
- `FullStackE2ETest.java` — MODIFY: new DTO field names + enum.
- `AsicSignatureE2ETest.java` — CREATE: sign a non-PDF via ASiC + validate.

---

## Task 1: Add ASiC dependency and service bean

**Files:**
- Modify: `eu-dss-server/pom.xml`
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/config/DssConfig.java`

- [ ] **Step 1: Add the dependency**

In `eu-dss-server/pom.xml`, add after the `dss-pades-pdfbox` dependency block:

```xml
        <dependency>
            <groupId>eu.europa.ec.joinup.sd-dss</groupId>
            <artifactId>dss-asic-xades</artifactId>
        </dependency>
```

- [ ] **Step 2: Add the ASiC service bean**

In `DssConfig.java`, add the import near the other DSS imports:

```java
import eu.europa.esig.dss.asic.xades.signature.ASiCWithXAdESService;
```

and add this bean method (next to `padesService`):

```java
    @Bean
    public ASiCWithXAdESService asicWithXAdESService(CommonCertificateVerifier verifier, TSPSource tspSource) {
        ASiCWithXAdESService service = new ASiCWithXAdESService(verifier);
        service.setTspSource(tspSource);
        return service;
    }
```

- [ ] **Step 3: Verify it builds and resolves**

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-server -am -DskipTests package`
Expected: `BUILD SUCCESS`; `unzip -l eu-dss-server/target/eu-dss-server-0.1.0-SNAPSHOT.jar | grep dss-asic-xades` shows the jar bundled.

- [ ] **Step 4: Commit**

```bash
git add eu-dss-server/pom.xml eu-dss-server/src/main/java/com/linagora/eudss/server/config/DssConfig.java
git commit -m "feat(backend): add dss-asic-xades dependency and ASiCWithXAdESService bean"
```

---

## Task 2: Make signature levels format-agnostic + extend SignatureMapper

This task has no behavior change for PDF; it renames the level enum and adds the XAdES/ASiC mapping helpers. The existing tests are updated in the same task so the build stays green.

**Files:**
- Modify: `dto/SignatureParamsDto.java`
- Modify: `service/SignatureMapper.java`
- Modify: `SignatureE2ETest.java`, `FullStackE2ETest.java` (enum references only)

- [ ] **Step 1: Rename the level enum to be format-agnostic**

Replace the enum block in `SignatureParamsDto.java` (lines 17-27) with:

```java
    public SignatureLevelDto signatureLevelOrDefault() {
        return signatureLevel != null ? signatureLevel : SignatureLevelDto.BASELINE_T;
    }

    public enum DigestAlgorithmDto {
        SHA256, SHA384, SHA512
    }

    public enum SignatureLevelDto {
        BASELINE_B, BASELINE_T, BASELINE_LT, BASELINE_LTA
    }
```

- [ ] **Step 2: Split level mapping and add ASiC params + firstCertificate in SignatureMapper**

In `SignatureMapper.java`, add imports:

```java
import eu.europa.esig.dss.asic.xades.ASiCWithXAdESSignatureParameters;
import eu.europa.esig.dss.enumerations.ASiCContainerType;
```

Change `toPadesParams` to call `toPadesLevel`:

```java
        params.setSignatureLevel(toPadesLevel(dto.signatureLevelOrDefault()));
```

Replace the old `toDssLevel` method with these three methods, and add `toAsicParams` + `firstCertificate`:

```java
    public static ASiCWithXAdESSignatureParameters toAsicParams(SignatureParamsDto dto) {
        ASiCWithXAdESSignatureParameters params = new ASiCWithXAdESSignatureParameters();
        params.aSiC().setContainerType(ASiCContainerType.ASiC_E);
        params.setSignatureLevel(toXadesLevel(dto.signatureLevelOrDefault()));
        params.setDigestAlgorithm(toDssDigest(dto.digestAlgorithm()));
        params.bLevel().setSigningDate(new Date(dto.signingTimeEpochMs()));

        List<CertificateToken> chain = decodeChain(dto.certificateChainBase64());
        params.setSigningCertificate(chain.get(0));
        params.setCertificateChain(chain);
        return params;
    }

    public static CertificateToken firstCertificate(List<String> chainBase64) {
        return decodeChain(chainBase64).get(0);
    }

    public static SignatureLevel toPadesLevel(SignatureParamsDto.SignatureLevelDto dto) {
        return switch (dto) {
            case BASELINE_B -> SignatureLevel.PAdES_BASELINE_B;
            case BASELINE_T -> SignatureLevel.PAdES_BASELINE_T;
            case BASELINE_LT -> SignatureLevel.PAdES_BASELINE_LT;
            case BASELINE_LTA -> SignatureLevel.PAdES_BASELINE_LTA;
        };
    }

    public static SignatureLevel toXadesLevel(SignatureParamsDto.SignatureLevelDto dto) {
        return switch (dto) {
            case BASELINE_B -> SignatureLevel.XAdES_BASELINE_B;
            case BASELINE_T -> SignatureLevel.XAdES_BASELINE_T;
            case BASELINE_LT -> SignatureLevel.XAdES_BASELINE_LT;
            case BASELINE_LTA -> SignatureLevel.XAdES_BASELINE_LTA;
        };
    }
```

- [ ] **Step 3: Update the two existing tests' enum references**

In `SignatureE2ETest.java` and `FullStackE2ETest.java`, replace `SignatureParamsDto.SignatureLevelDto.PADES_BASELINE_B` with `SignatureParamsDto.SignatureLevelDto.BASELINE_B`.

- [ ] **Step 4: Verify the module compiles** (tests will still fail to compile until Task 3 renames DTO fields — that's expected; just compile main sources here)

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-server -am -DskipTests compile`
Expected: `BUILD SUCCESS` (main sources compile).

- [ ] **Step 5: Commit**

```bash
git add eu-dss-server/src/main/java/com/linagora/eudss/server/dto/SignatureParamsDto.java \
        eu-dss-server/src/main/java/com/linagora/eudss/server/service/SignatureMapper.java \
        eu-dss-server/src/test/java/com/linagora/eudss/server/SignatureE2ETest.java \
        eu-dss-server/src/test/java/com/linagora/eudss/server/FullStackE2ETest.java
git commit -m "refactor(backend): format-agnostic signature levels + XAdES/ASiC mapping"
```

---

## Task 3: DocumentSigner interface, ASiC signer, and the format-dispatching facade

This replaces the PDF-only `PadesSigningService` request handling with a generic facade. Existing PDF behavior is preserved (the PDF E2E test still passes). DTO field renames happen here, and the existing tests are updated so the build is green at the end of the task. The new ASiC behavior is driven by a failing test first.

**Files:**
- Create: `service/DocumentSigner.java`, `service/SigningFormat.java`, `service/AsicSigningService.java`, `service/DocumentSigningService.java`
- Modify: `service/PadesSigningService.java`
- Modify: `dto/PrepareSignatureRequest.java`, `dto/AssembleSignatureRequest.java`, `dto/AssembleSignatureResponse.java`
- Modify: `web/SignatureController.java`
- Rename+Modify: `service/PdfValidationService.java` → `service/DocumentValidationService.java`; `web/ValidationController.java`
- Create (failing test first): `AsicSignatureE2ETest.java`
- Modify: `SignatureE2ETest.java`, `FullStackE2ETest.java` (DTO field renames)

- [ ] **Step 1: Write the failing ASiC E2E test**

Create `eu-dss-server/src/test/java/com/linagora/eudss/server/AsicSignatureE2ETest.java`:

```java
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
        // Any non-PDF payload is wrapped in an ASiC-E / XAdES container.
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
```

- [ ] **Step 2: Create the format detector**

Create `service/SigningFormat.java`:

```java
package com.linagora.eudss.server.service;

import java.util.Locale;

public enum SigningFormat {
    PADES,
    ASIC;

    /** PDFs are signed in place (PAdES); everything else is wrapped in an ASiC-E/XAdES container. */
    public static SigningFormat forFileName(String fileName) {
        String name = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        return name.endsWith(".pdf") ? PADES : ASIC;
    }
}
```

- [ ] **Step 3: Create the DocumentSigner interface**

Create `service/DocumentSigner.java`:

```java
package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;

/** One signature format (PAdES, ASiC/XAdES, …). Stateless: prepare and sign rebuild DSS params from the DTO. */
public interface DocumentSigner {
    ToBeSigned dataToSign(DSSDocument document, SignatureParamsDto params);

    DSSDocument sign(DSSDocument document, SignatureParamsDto params, SignatureValue signatureValue);
}
```

- [ ] **Step 4: Refactor PadesSigningService to implement DocumentSigner**

Replace the whole body of `service/PadesSigningService.java` with:

```java
package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.pades.signature.PAdESService;
import org.springframework.stereotype.Service;

@Service
public class PadesSigningService implements DocumentSigner {

    private final PAdESService padesService;

    public PadesSigningService(PAdESService padesService) {
        this.padesService = padesService;
    }

    @Override
    public ToBeSigned dataToSign(DSSDocument document, SignatureParamsDto params) {
        return padesService.getDataToSign(document, SignatureMapper.toPadesParams(params));
    }

    @Override
    public DSSDocument sign(DSSDocument document, SignatureParamsDto params, SignatureValue signatureValue) {
        return padesService.signDocument(document, SignatureMapper.toPadesParams(params), signatureValue);
    }
}
```

- [ ] **Step 5: Create AsicSigningService**

Create `service/AsicSigningService.java`:

```java
package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.asic.xades.signature.ASiCWithXAdESService;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import org.springframework.stereotype.Service;

@Service
public class AsicSigningService implements DocumentSigner {

    private final ASiCWithXAdESService asicService;

    public AsicSigningService(ASiCWithXAdESService asicService) {
        this.asicService = asicService;
    }

    @Override
    public ToBeSigned dataToSign(DSSDocument document, SignatureParamsDto params) {
        return asicService.getDataToSign(document, SignatureMapper.toAsicParams(params));
    }

    @Override
    public DSSDocument sign(DSSDocument document, SignatureParamsDto params, SignatureValue signatureValue) {
        return asicService.signDocument(document, SignatureMapper.toAsicParams(params), signatureValue);
    }
}
```

- [ ] **Step 6: Create the DocumentSigningService facade**

Create `service/DocumentSigningService.java`:

```java
package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.AssembleSignatureRequest;
import com.linagora.eudss.server.dto.AssembleSignatureResponse;
import com.linagora.eudss.server.dto.PrepareSignatureRequest;
import com.linagora.eudss.server.dto.PrepareSignatureResponse;
import com.linagora.eudss.server.dto.SignatureParamsDto;
import eu.europa.esig.dss.enumerations.EncryptionAlgorithm;
import eu.europa.esig.dss.enumerations.SignatureAlgorithm;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.spi.DSSUtils;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;

@Service
public class DocumentSigningService {

    private final PadesSigningService padesSigner;
    private final AsicSigningService asicSigner;

    public DocumentSigningService(PadesSigningService padesSigner, AsicSigningService asicSigner) {
        this.padesSigner = padesSigner;
        this.asicSigner = asicSigner;
    }

    public PrepareSignatureResponse prepare(PrepareSignatureRequest req) {
        DSSDocument document = toDocument(req.documentBase64(), req.documentName());
        ToBeSigned dataToSign = signerFor(req.documentName()).dataToSign(document, req.params());
        byte[] digest = DSSUtils.digest(SignatureMapper.toDssDigest(req.params().digestAlgorithm()), dataToSign.getBytes());
        return new PrepareSignatureResponse(
                Base64.getEncoder().encodeToString(dataToSign.getBytes()),
                Base64.getEncoder().encodeToString(digest));
    }

    public AssembleSignatureResponse assemble(AssembleSignatureRequest req) {
        DSSDocument document = toDocument(req.documentBase64(), req.documentName());
        SignatureValue signatureValue = signatureValue(req.params(), Base64.getDecoder().decode(req.signatureValueBase64()));
        DSSDocument signed = signerFor(req.documentName()).sign(document, req.params(), signatureValue);
        byte[] bytes = toBytes(signed);
        String mediaType = signed.getMimeType() != null ? signed.getMimeType().getMimeTypeString() : "application/octet-stream";
        return new AssembleSignatureResponse(
                Base64.getEncoder().encodeToString(bytes),
                signedFileName(req.documentName()),
                mediaType);
    }

    private DocumentSigner signerFor(String fileName) {
        return SigningFormat.forFileName(fileName) == SigningFormat.PADES ? padesSigner : asicSigner;
    }

    private static DSSDocument toDocument(String base64, String fileName) {
        return new InMemoryDocument(Base64.getDecoder().decode(base64), fileName);
    }

    private static SignatureValue signatureValue(SignatureParamsDto params, byte[] rawSignature) {
        CertificateToken signingCert = SignatureMapper.firstCertificate(params.certificateChainBase64());
        EncryptionAlgorithm encryption = EncryptionAlgorithm.forKey(signingCert.getPublicKey());
        SignatureValue value = new SignatureValue();
        value.setAlgorithm(SignatureAlgorithm.getAlgorithm(encryption, SignatureMapper.toDssDigest(params.digestAlgorithm())));
        value.setValue(rawSignature);
        return value;
    }

    /** PDFs keep their name; everything else becomes an .asice container. */
    private static String signedFileName(String fileName) {
        if (SigningFormat.forFileName(fileName) == SigningFormat.PADES) {
            return fileName;
        }
        String base = fileName == null || fileName.isBlank() ? "document" : fileName;
        int dot = base.lastIndexOf('.');
        if (dot > 0) {
            base = base.substring(0, dot);
        }
        return base + ".asice";
    }

    private static byte[] toBytes(DSSDocument document) {
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            document.writeTo(baos);
            return baos.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("Failed to serialize signed document", e);
        }
    }
}
```

- [ ] **Step 7: Rename DTO fields (request/response)**

Replace `dto/PrepareSignatureRequest.java`:

```java
package com.linagora.eudss.server.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record PrepareSignatureRequest(
        @NotBlank String documentBase64,
        @NotBlank String documentName,
        @NotNull @Valid SignatureParamsDto params
) {}
```

Replace `dto/AssembleSignatureRequest.java`:

```java
package com.linagora.eudss.server.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record AssembleSignatureRequest(
        @NotBlank String documentBase64,
        @NotBlank String documentName,
        @NotNull @Valid SignatureParamsDto params,
        @NotBlank String signatureValueBase64
) {}
```

Replace `dto/AssembleSignatureResponse.java`:

```java
package com.linagora.eudss.server.dto;

public record AssembleSignatureResponse(
        String signedDocumentBase64,
        String signedFileName,
        String mediaType
) {}
```

- [ ] **Step 8: Point the signature controller at the facade**

Replace `web/SignatureController.java`:

```java
package com.linagora.eudss.server.web;

import com.linagora.eudss.server.dto.AssembleSignatureRequest;
import com.linagora.eudss.server.dto.AssembleSignatureResponse;
import com.linagora.eudss.server.dto.PrepareSignatureRequest;
import com.linagora.eudss.server.dto.PrepareSignatureResponse;
import com.linagora.eudss.server.service.DocumentSigningService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sign")
public class SignatureController {

    private final DocumentSigningService service;

    public SignatureController(DocumentSigningService service) {
        this.service = service;
    }

    @PostMapping("/prepare")
    public PrepareSignatureResponse prepare(@Valid @RequestBody PrepareSignatureRequest req) {
        return service.prepare(req);
    }

    @PostMapping("/assemble")
    public AssembleSignatureResponse assemble(@Valid @RequestBody AssembleSignatureRequest req) {
        return service.assemble(req);
    }
}
```

- [ ] **Step 9: Rename the validation service and DTO field**

Rename the file `service/PdfValidationService.java` to `service/DocumentValidationService.java` and replace its content:

```java
package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.simplereport.SimpleReport;
import eu.europa.esig.dss.simplereport.SimpleReportFacade;
import eu.europa.esig.dss.spi.validation.CommonCertificateVerifier;
import eu.europa.esig.dss.validation.SignedDocumentValidator;
import eu.europa.esig.dss.validation.reports.Reports;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

@Service
public class DocumentValidationService {

    private final CommonCertificateVerifier verifier;

    public DocumentValidationService(CommonCertificateVerifier verifier) {
        this.verifier = verifier;
    }

    public ValidationResponseDto validate(String documentBase64) {
        DSSDocument document = new InMemoryDocument(Base64.getDecoder().decode(documentBase64), "document");
        SignedDocumentValidator validator = SignedDocumentValidator.fromDocument(document);
        validator.setCertificateVerifier(verifier);
        Reports reports = validator.validateDocument();

        SimpleReport simple = reports.getSimpleReport();
        List<ValidationResponseDto.SignatureSummary> summaries = new ArrayList<>();
        for (String sigId : simple.getSignatureIdList()) {
            summaries.add(new ValidationResponseDto.SignatureSummary(
                    sigId,
                    simple.getSignatureFormat(sigId) != null ? simple.getSignatureFormat(sigId).toString() : null,
                    String.valueOf(simple.getIndication(sigId)),
                    simple.getSubIndication(sigId) != null ? simple.getSubIndication(sigId).toString() : null,
                    simple.getSignedBy(sigId),
                    simple.getSigningTime(sigId) != null
                            ? simple.getSigningTime(sigId).toInstant().atOffset(ZoneOffset.UTC).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
                            : null
            ));
        }
        return new ValidationResponseDto(simple.getSignaturesCount(), summaries, marshalSimpleReport(reports));
    }

    private String marshalSimpleReport(Reports reports) {
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            SimpleReportFacade.newFacade().marshall(reports.getSimpleReportJaxb(), baos);
            return baos.toString(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
```

Then delete the old file: `git rm eu-dss-server/src/main/java/com/linagora/eudss/server/service/PdfValidationService.java` (if your editor kept it).

Replace `web/ValidationController.java`:

```java
package com.linagora.eudss.server.web;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.service.DocumentValidationService;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/validate")
public class ValidationController {

    private final DocumentValidationService service;

    public ValidationController(DocumentValidationService service) {
        this.service = service;
    }

    public record ValidateRequest(@NotBlank String documentBase64) {}

    @PostMapping
    public ValidationResponseDto validate(@RequestBody ValidateRequest req) {
        return service.validate(req.documentBase64());
    }
}
```

- [ ] **Step 10: Update the two existing E2E tests to the new DTO fields**

In `SignatureE2ETest.java`:
- `new PrepareSignatureRequest(pdfB64, params)` → `new PrepareSignatureRequest(pdfB64, "document.pdf", params)`
- `new AssembleSignatureRequest(pdfB64, params, Base64.getEncoder().encodeToString(signatureValue))` → `new AssembleSignatureRequest(pdfB64, "document.pdf", params, Base64.getEncoder().encodeToString(signatureValue))`
- `new ValidationController.ValidateRequest(assembled.signedPdfBase64())` → `new ValidationController.ValidateRequest(assembled.signedDocumentBase64())`

In `FullStackE2ETest.java`:
- `new PrepareSignatureRequest(pdfB64, params)` → `new PrepareSignatureRequest(pdfB64, "document.pdf", params)`
- `new AssembleSignatureRequest(pdfB64, params, signatureValueB64)` → `new AssembleSignatureRequest(pdfB64, "document.pdf", params, signatureValueB64)`
- `new ValidationController.ValidateRequest(assembled.signedPdfBase64())` → `new ValidationController.ValidateRequest(assembled.signedDocumentBase64())`

- [ ] **Step 11: Run the whole suite (PDF + ASiC + full-stack)**

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-server -am test`
Expected: `BUILD SUCCESS`; `AsicSignatureE2ETest` passes (XAdES, count=1), `SignatureE2ETest` + `FullStackE2ETest` still pass.

- [ ] **Step 12: Commit**

```bash
git add eu-dss-server/src/main/java/com/linagora/eudss/server/ eu-dss-server/src/test/java/com/linagora/eudss/server/
git commit -m "feat(backend): multi-format signing facade (PDF=PAdES, others=ASiC-E/XAdES) + generalized DTOs"
```

---

## Task 4: Co-signature (multiple independent signatures)

Verifies that signing an already-signed document adds a second independent signature (PDF incremental update). This should already work through the facade; the test locks it in.

**Files:**
- Modify: `SignatureE2ETest.java` (add one test method)

- [ ] **Step 1: Write the co-signature test**

Add this method to `SignatureE2ETest.java` (it reuses the class fields `pki`, `pdfBytes`, `http`). It signs the PDF, then signs the *signed* PDF again, and expects two signatures:

```java
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
```

- [ ] **Step 2: Run the test**

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml -pl eu-dss-server -am test -Dtest=SignatureE2ETest`
Expected: PASS, including `co_signature_adds_a_second_independent_signature` (`signatureCount == 2`).

Note: if the second signature reports `signatureCount == 1`, the first signature was overwritten instead of incrementally added — check that PAdES uses the default incremental update (it does by default; do NOT set a packaging that flattens the document).

- [ ] **Step 3: Commit**

```bash
git add eu-dss-server/src/test/java/com/linagora/eudss/server/SignatureE2ETest.java
git commit -m "test(backend): co-signature adds a second independent signature"
```

---

## Task 5: Full verification

**Files:** none (verification + commit only)

- [ ] **Step 1: Run the full suite**

Run: `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home mvn -f /Users/mmaudet/work/eu-dss/pom.xml test`
Expected: `BUILD SUCCESS`; agent tests (5: 4 smoke + `AgentConfigDefaultsTest` 3 → actually 4+3) and server tests all green, including the new ASiC + co-signature tests. Confirm `Failures: 0, Errors: 0`.

- [ ] **Step 2: Optional manual smoke (real token)** — only if a signer wants to verify against hardware:

Rebuild + run the backend (`eudss.lotl.enabled` default true) and the agent (slot 0, 4-digit PIN), then sign a `.docx` via the 3-call flow and confirm `/api/validate` reports an `XAdES` signature inside an ASiC container. (Reuse the pattern in `/tmp/eudss_sign_flow.py`, changing the document + `documentName` to `*.docx`.)

- [ ] **Step 3: Final commit (if any uncommitted verification artifacts)**

```bash
git status
# nothing to commit expected; the work was committed per task
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §5 backend items map to tasks — ASiC dep + bean (T1), format-agnostic levels + XAdES/ASiC mapping (T2), `DocumentSigningService` dispatch + `AsicSigningService` + DTO generalization (T3), validation generalization/rename (T3), co-signature (T4), TSA reuse (bean in T1, used by both services). Multi-document "sign all", ZIP, and the workspace UI are explicitly in **A2 (UI plan)**, not here.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command + expected result.

**Type consistency:** `DocumentSigner.dataToSign/sign`, `SignatureMapper.toPadesParams/toAsicParams/toDssDigest/toPadesLevel/toXadesLevel/firstCertificate`, `SigningFormat.forFileName`, DTO fields `documentBase64`/`documentName`/`signedDocumentBase64`/`signedFileName`/`mediaType`, and `ValidateRequest.documentBase64` are used consistently across tasks and tests.

**Known risk:** exact DSS 6.4 ASiC API names (`ASiCWithXAdESService`, `ASiCWithXAdESSignatureParameters`, `params.aSiC().setContainerType`, `ASiCContainerType.ASiC_E`) — if any does not resolve, confirm with the `javap` one-liner in the conventions section before adapting.
