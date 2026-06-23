# Detached Signature Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make eu-dss verify detached signatures (signature + source document pair) and stop producing loose detached XAdES, so the app never creates a signature it cannot itself verify.

**Architecture:** The backend (EU DSS) becomes the single source of truth for signature classification: on validation it returns one of three `kind`s — `VALIDATED` (self-contained), `DETACHED_CONTENT_REQUIRED`, or `NOT_A_SIGNATURE` — and wires `setDetachedContents()` when a second document is supplied. The UI keeps one smart drop-zone that asks for the second file only when the backend says so. The "XAdES détaché" generation option is removed end-to-end.

**Tech Stack:** Java 21, Spring Boot 3.4, EU DSS 6.4, JUnit 5 + AssertJ (backend); React 19, TypeScript 5.7, Vite 6, Tauri 2 (UI). Spec: `docs/specs/2026-06-23-detached-signature-handling-design.md`.

## Global Constraints

- Backend module build/test: `mvn -B -pl eu-dss-server -am test` (single class: append `-Dtest=ClassName`). No Maven wrapper — use `mvn`.
- UI has **no unit-test runner** (package.json scripts: dev/build/preview/tauri). Do **not** add one (YAGNI / follow existing patterns). The UI gate is `cd eu-dss-ui && npm run build` (runs `tsc -b && vite build` — full typecheck + bundle). Manual smoke uses `cd eu-dss-ui && npm run tauri dev`.
- The validate HTTP contract stays **JSON + base64** and **backward-compatible**: a body with only `documentBase64` must keep working (existing `selfTest.ts`, `SignWorkspace.detect()`).
- Branch: `feat/detached-signature-handling` (already created; the design spec is committed there).
- Commit trailers (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014b4SFcqwjvEG4NjFyybtma
  ```
- DSS detection facts (verified against the current code): for a missing detached document DSS yields `SubIndication.SIGNED_DATA_NOT_FOUND`; for an unrecognised container (e.g. a plain `.xlsx` ZIP) `SignedDocumentValidator.fromDocument` throws `UnsupportedOperationException`; for an unsigned but recognised file (e.g. a plain PDF) it returns 0 signatures.

---

## File Structure

**Backend (`eu-dss-server`)**
- `dto/ValidationResponseDto.java` — add `ValidationKind kind` + nested `enum ValidationKind`.
- `service/DocumentValidationService.java` — 4-arg `validate(...)`, 3-way classification, `setDetachedContents`.
- `web/ValidationController.java` — `ValidateRequest` gains 3 optional fields (+ a 1-arg convenience constructor for back-compat).
- `dto/SignatureParamsDto.java`, `service/SigningFormat.java`, `service/DocumentSigningService.java`, `config/DssConfig.java` — remove the `XADES_DETACHED` generation path.
- `test/.../testutil/XadesFixtures.java` (new) — builds detached/enveloping XAdES fixtures with the test PKI.
- `test/.../DocumentValidationServiceTest.java` (new) — service-level classification matrix.
- `test/.../ValidationApiTest.java` (new) — HTTP contract for the pair + the "detached generation rejected" guard.

**UI (`eu-dss-ui`)**
- `services/backendApi.ts` — `ValidationKind` + `kind` on `ValidationResponse`; `validate()` gains optional detached content; remove `XADES_DETACHED` from `SignatureForm`.
- `components/ValidatePage.tsx` — smart single-zone state machine (2nd file + role swap).
- `components/SignWorkspace.tsx` — drop the detached menu option, label, and note.
- `components/DeepLinkVerifyModal.tsx` — surface a clear "not supported by link" message for detached.
- `i18n/dict.ts` — remove 2 keys (FR+EN), add verify/deeplink keys (FR+EN).

**Docs**
- `README.md`, `docs/deeplink-integration.md`.

---

## Task 1: Backend — detached-aware validation + API contract

**Files:**
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/dto/ValidationResponseDto.java`
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/service/DocumentValidationService.java`
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/web/ValidationController.java`
- Create: `eu-dss-server/src/test/java/com/linagora/eudss/server/testutil/XadesFixtures.java`
- Create: `eu-dss-server/src/test/java/com/linagora/eudss/server/DocumentValidationServiceTest.java`
- Create: `eu-dss-server/src/test/java/com/linagora/eudss/server/ValidationApiTest.java`

**Interfaces:**
- Produces: `ValidationResponseDto.ValidationKind { VALIDATED, DETACHED_CONTENT_REQUIRED, NOT_A_SIGNATURE }`
- Produces: `ValidationResponseDto(ValidationKind kind, int signatureCount, List<SignatureSummary> signatures, String simpleReportXml)`
- Produces: `DocumentValidationService.validate(String documentBase64, String documentName, String detachedContentBase64, String detachedContentName) → ValidationResponseDto`
- Produces: `ValidationController.ValidateRequest(String documentBase64, String documentName, String detachedContentBase64, String detachedContentName)` + convenience `ValidateRequest(String documentBase64)`
- Produces (test util): `XadesFixtures.xades(XAdESService, TestPki.SelfSigned, SignaturePackaging, byte[] original, String name) → byte[]`

- [ ] **Step 1: Write the test fixture helper** (test util used by the failing tests)

Create `eu-dss-server/src/test/java/com/linagora/eudss/server/testutil/XadesFixtures.java`:

```java
package com.linagora.eudss.server.testutil;

import com.linagora.eudss.server.dto.SignatureParamsDto;
import com.linagora.eudss.server.service.XadesSigningService;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import eu.europa.esig.dss.enumerations.EncryptionAlgorithm;
import eu.europa.esig.dss.enumerations.SignatureAlgorithm;
import eu.europa.esig.dss.enumerations.SignaturePackaging;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.ToBeSigned;
import eu.europa.esig.dss.xades.signature.XAdESService;

import java.io.ByteArrayOutputStream;
import java.security.Signature;
import java.util.Base64;
import java.util.List;

/**
 * Builds standalone XAdES signatures (DETACHED or ENVELOPING) for validation tests, reusing the
 * production {@link XadesSigningService} + a software {@link TestPki} key. Mirrors the real
 * prepare/sign/assemble round-trip (getDataToSign -> raw RSA sign -> signDocument).
 */
public final class XadesFixtures {

    private XadesFixtures() {}

    /** Returns the produced XAdES signature bytes (for DETACHED, the signature only). */
    public static byte[] xades(XAdESService xadesService, TestPki.SelfSigned pki,
                               SignaturePackaging packaging, byte[] original, String originalName) throws Exception {
        String certB64 = Base64.getEncoder().encodeToString(pki.certificate().getEncoded());
        SignatureParamsDto params = new SignatureParamsDto(
                List.of(certB64),
                SignatureParamsDto.DigestAlgorithmDto.SHA256,
                System.currentTimeMillis(),
                SignatureParamsDto.SignatureLevelDto.BASELINE_B,
                "fixture", "Paris", "eu-dss test signer");

        XadesSigningService signer = new XadesSigningService(xadesService, packaging);
        DSSDocument doc = new InMemoryDocument(original, originalName);

        ToBeSigned tbs = signer.dataToSign(doc, params);
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initSign(pki.privateKey());
        s.update(tbs.getBytes());
        SignatureValue sv = new SignatureValue();
        sv.setAlgorithm(SignatureAlgorithm.getAlgorithm(EncryptionAlgorithm.RSA, DigestAlgorithm.SHA256));
        sv.setValue(s.sign());

        DSSDocument signed = signer.sign(doc, params, sv);
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            signed.writeTo(baos);
            return baos.toByteArray();
        }
    }
}
```

- [ ] **Step 2: Write the failing service test** (classification matrix)

Create `eu-dss-server/src/test/java/com/linagora/eudss/server/DocumentValidationServiceTest.java`:

```java
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
```

- [ ] **Step 3: Write the failing HTTP contract test**

Create `eu-dss-server/src/test/java/com/linagora/eudss/server/ValidationApiTest.java`:

```java
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
```

- [ ] **Step 4: Run the new tests to verify they fail (do not compile)**

Run: `mvn -B -pl eu-dss-server -am test -Dtest=DocumentValidationServiceTest,ValidationApiTest`
Expected: FAIL — compilation errors (`ValidationKind` / 4-arg `validate` / 4-arg `ValidateRequest` do not exist yet).

- [ ] **Step 5: Add `kind` + `ValidationKind` to the response DTO**

Replace the body of `eu-dss-server/src/main/java/com/linagora/eudss/server/dto/ValidationResponseDto.java`:

```java
package com.linagora.eudss.server.dto;

import java.util.List;

public record ValidationResponseDto(
        ValidationKind kind,
        int signatureCount,
        List<SignatureSummary> signatures,
        String simpleReportXml
) {
    /** Outcome of inspecting the uploaded file (drives the verify UI). */
    public enum ValidationKind {
        /** A signature (self-contained, or detached with its content supplied) was validated. */
        VALIDATED,
        /** A detached signature whose original document is missing — caller must resend with it. */
        DETACHED_CONTENT_REQUIRED,
        /** No signature found (e.g. the caller uploaded the source document instead). */
        NOT_A_SIGNATURE
    }

    public record SignatureSummary(
            String signatureId,
            String signatureFormat,
            String indication,
            String subIndication,
            String signedBy,
            String signingDate
    ) {}
}
```

- [ ] **Step 6: Rewrite `DocumentValidationService` with classification + detached content**

Replace `eu-dss-server/src/main/java/com/linagora/eudss/server/service/DocumentValidationService.java` with:

```java
package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.dto.ValidationResponseDto.SignatureSummary;
import com.linagora.eudss.server.dto.ValidationResponseDto.ValidationKind;
import eu.europa.esig.dss.enumerations.SubIndication;
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

    /**
     * Validates an uploaded file. When {@code detachedContentBase64} is supplied it is wired as the
     * detached signed data ({@link SignedDocumentValidator#setDetachedContents}). The returned
     * {@link ValidationKind} tells the caller whether it must resend with the missing document.
     */
    public ValidationResponseDto validate(String documentBase64, String documentName,
                                          String detachedContentBase64, String detachedContentName) {
        DSSDocument document = new InMemoryDocument(
                Base64.getDecoder().decode(documentBase64),
                hasText(documentName) ? documentName : "document");

        SignedDocumentValidator validator;
        try {
            validator = SignedDocumentValidator.fromDocument(document);
        } catch (UnsupportedOperationException e) {
            // DSS does not recognise this file as any signature container (e.g. a plain .xlsx ZIP).
            return notASignature();
        }
        validator.setCertificateVerifier(verifier);

        boolean detachedProvided = hasText(detachedContentBase64);
        if (detachedProvided) {
            DSSDocument original = new InMemoryDocument(
                    Base64.getDecoder().decode(detachedContentBase64),
                    hasText(detachedContentName) ? detachedContentName : "detached-content");
            validator.setDetachedContents(List.of(original));
        }

        Reports reports = validator.validateDocument();
        SimpleReport simple = reports.getSimpleReport();

        if (simple.getSignaturesCount() == 0) {
            return notASignature();
        }
        if (!detachedProvided && needsDetachedContent(simple)) {
            return new ValidationResponseDto(ValidationKind.DETACHED_CONTENT_REQUIRED, 0, List.of(), null);
        }

        List<SignatureSummary> summaries = new ArrayList<>();
        for (String sigId : simple.getSignatureIdList()) {
            summaries.add(new SignatureSummary(
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
        return new ValidationResponseDto(ValidationKind.VALIDATED, simple.getSignaturesCount(), summaries, marshalSimpleReport(reports));
    }

    /** A signature whose detached content is missing surfaces as SIGNED_DATA_NOT_FOUND. */
    private static boolean needsDetachedContent(SimpleReport simple) {
        for (String sigId : simple.getSignatureIdList()) {
            if (simple.getSubIndication(sigId) == SubIndication.SIGNED_DATA_NOT_FOUND) {
                return true;
            }
        }
        return false;
    }

    private static ValidationResponseDto notASignature() {
        return new ValidationResponseDto(ValidationKind.NOT_A_SIGNATURE, 0, List.of(), null);
    }

    private static boolean hasText(String s) {
        return s != null && !s.isBlank();
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

- [ ] **Step 7: Extend the controller contract** (keep the old 1-arg call compiling)

Replace `eu-dss-server/src/main/java/com/linagora/eudss/server/web/ValidationController.java` with:

```java
package com.linagora.eudss.server.web;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.service.DocumentValidationService;
import jakarta.validation.Valid;
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

    /**
     * Validation request. Only {@code documentBase64} is required. For a DETACHED signature, the
     * caller resends with {@code detachedContentBase64} (+ optional {@code detachedContentName} so
     * XAdES references that resolve by file name match).
     */
    public record ValidateRequest(
            @NotBlank String documentBase64,
            String documentName,
            String detachedContentBase64,
            String detachedContentName) {

        /** Back-compatible single-file request (no detached content). */
        public ValidateRequest(String documentBase64) {
            this(documentBase64, null, null, null);
        }
    }

    @PostMapping
    public ValidationResponseDto validate(@Valid @RequestBody ValidateRequest req) {
        return service.validate(req.documentBase64(), req.documentName(),
                req.detachedContentBase64(), req.detachedContentName());
    }
}
```

- [ ] **Step 8: Run the new tests + the existing suite to verify green**

Run: `mvn -B -pl eu-dss-server -am test -Dtest=DocumentValidationServiceTest,ValidationApiTest,SignatureE2ETest`
Expected: PASS (all). `SignatureE2ETest` confirms the 1-arg `ValidateRequest` + `signatureCount()`/`signatures()` accessors still work.

- [ ] **Step 9: Commit**

```bash
git add eu-dss-server/src/main/java/com/linagora/eudss/server/dto/ValidationResponseDto.java \
        eu-dss-server/src/main/java/com/linagora/eudss/server/service/DocumentValidationService.java \
        eu-dss-server/src/main/java/com/linagora/eudss/server/web/ValidationController.java \
        eu-dss-server/src/test/java/com/linagora/eudss/server/testutil/XadesFixtures.java \
        eu-dss-server/src/test/java/com/linagora/eudss/server/DocumentValidationServiceTest.java \
        eu-dss-server/src/test/java/com/linagora/eudss/server/ValidationApiTest.java
git commit  # message: "feat(validate): detached-aware validation + 3-way classification" + trailers
```

---

## Task 2: Backend — remove the XAdES-detached generation path

**Files:**
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/dto/SignatureParamsDto.java`
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/service/SigningFormat.java`
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/service/DocumentSigningService.java`
- Modify: `eu-dss-server/src/main/java/com/linagora/eudss/server/config/DssConfig.java`
- Modify: `eu-dss-server/src/test/java/com/linagora/eudss/server/ValidationApiTest.java` (add the guard test)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; `XadesFixtures` (Task 1) constructs `XadesSigningService` with `SignaturePackaging.DETACHED` **directly**, so it is unaffected by this removal.
- Produces: `SignatureFormDto { PADES, ASIC_E, XADES_ENVELOPING }` (no `XADES_DETACHED`); posting `"signatureForm":"XADES_DETACHED"` now yields HTTP 400 (Jackson rejects the unknown enum — `JacksonConfig` does not relax this).

- [ ] **Step 1: Write the failing guard test** (append to `ValidationApiTest.java`)

Add these imports near the top of `ValidationApiTest.java`:

```java
import com.linagora.eudss.server.testutil.SamplePdf;
import org.springframework.http.ResponseEntity;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
```

Add this test method inside the class:

```java
    @Test
    void requesting_detached_generation_is_rejected() throws Exception {
        String pdfB64 = b64(SamplePdf.simpleA4WithText("x"));
        String certB64 = b64(pki.certificate().getEncoded());

        Map<String, Object> params = new HashMap<>();
        params.put("certificateChainBase64", List.of(certB64));
        params.put("digestAlgorithm", "SHA256");
        params.put("signingTimeEpochMs", System.currentTimeMillis());
        params.put("signatureLevel", "BASELINE_B");
        params.put("signatureForm", "XADES_DETACHED"); // removed value -> unknown enum -> 400

        Map<String, Object> body = new HashMap<>();
        body.put("documentBase64", pdfB64);
        body.put("documentName", "document.pdf");
        body.put("params", params);

        ResponseEntity<String> resp = http.postForEntity("/api/sign/prepare", body, String.class);
        assertThat(resp.getStatusCode().value()).isEqualTo(400);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `mvn -B -pl eu-dss-server -am test -Dtest=ValidationApiTest#requesting_detached_generation_is_rejected`
Expected: FAIL — today `XADES_DETACHED` is a valid enum value, so the request succeeds (200), not 400.

- [ ] **Step 3: Remove `XADES_DETACHED` from `SignatureFormDto`**

In `eu-dss-server/src/main/java/com/linagora/eudss/server/dto/SignatureParamsDto.java`:

Remove the javadoc bullet (the `<li>{@code XADES_DETACHED} ...</li>` line, originally line 55-56), and change the enum (originally line 59-61) from:

```java
    public enum SignatureFormDto {
        PADES, ASIC_E, XADES_ENVELOPING, XADES_DETACHED
    }
```

to:

```java
    public enum SignatureFormDto {
        PADES, ASIC_E, XADES_ENVELOPING
    }
```

- [ ] **Step 4: Remove `XADES_DETACHED` from `SigningFormat`**

In `eu-dss-server/src/main/java/com/linagora/eudss/server/service/SigningFormat.java`:

Delete the enum constant (originally line 18-19):

```java
    /** Standalone XAdES signature, DETACHED packaging (only the signature XML is returned). */
    XADES_DETACHED;
```

so the enum ends at `XADES_ENVELOPING;` (change the trailing comma on the `XADES_ENVELOPING` line to a semicolon). Then delete the resolve case (originally line 39):

```java
            case XADES_DETACHED -> XADES_DETACHED;
```

Resulting `resolve` switch:

```java
        return switch (form) {
            case PADES -> PADES;
            case ASIC_E -> ASIC;
            case XADES_ENVELOPING -> XADES_ENVELOPING;
        };
```

- [ ] **Step 5: Remove the detached signer from `DocumentSigningService`**

In `eu-dss-server/src/main/java/com/linagora/eudss/server/service/DocumentSigningService.java`:

(a) Delete the field (line 29): `private final DocumentSigner xadesDetachedSigner;`

(b) Change the constructor (lines 31-39) to drop the param + assignment:

```java
    public DocumentSigningService(@Qualifier("padesSigningService") DocumentSigner padesSigner,
                                  @Qualifier("asicSigningService") DocumentSigner asicSigner,
                                  @Qualifier("xadesEnvelopingSigningService") DocumentSigner xadesEnvelopingSigner) {
        this.padesSigner = padesSigner;
        this.asicSigner = asicSigner;
        this.xadesEnvelopingSigner = xadesEnvelopingSigner;
    }
```

(c) Delete the `signerFor` case (line 79): `case XADES_DETACHED -> xadesDetachedSigner;`

(d) Change `signedFileName` (line 109) from:

```java
            case XADES_ENVELOPING, XADES_DETACHED -> base + ".xml";
```

to:

```java
            case XADES_ENVELOPING -> base + ".xml";
```

- [ ] **Step 6: Remove the detached bean from `DssConfig`**

In `eu-dss-server/src/main/java/com/linagora/eudss/server/config/DssConfig.java`, delete the bean (lines 171-174):

```java
    @Bean
    public DocumentSigner xadesDetachedSigningService(XAdESService xadesService) {
        return new XadesSigningService(xadesService, SignaturePackaging.DETACHED);
    }
```

(Keep `xadesEnvelopingSigningService` and the `xadesService` bean — both still used. `SignaturePackaging` may now be an unused import; remove it only if the compiler warns/`-Werror` — otherwise leave.)

- [ ] **Step 7: Run the full backend suite**

Run: `mvn -B -pl eu-dss-server -am test`
Expected: PASS. The guard test now returns 400; `XadesFixtures`-based tests still pass (they build the detached signer directly); `SignatureE2ETest` (PAdES) and `AsicSignatureE2ETest` unaffected.

- [ ] **Step 8: Commit**

```bash
git add eu-dss-server/src/main/java/com/linagora/eudss/server/dto/SignatureParamsDto.java \
        eu-dss-server/src/main/java/com/linagora/eudss/server/service/SigningFormat.java \
        eu-dss-server/src/main/java/com/linagora/eudss/server/service/DocumentSigningService.java \
        eu-dss-server/src/main/java/com/linagora/eudss/server/config/DssConfig.java \
        eu-dss-server/src/test/java/com/linagora/eudss/server/ValidationApiTest.java
git commit  # message: "feat(sign): drop XAdES-detached generation (reject at API)" + trailers
```

---

## Task 3: UI — validate() contract + ValidationKind (additive, build stays green)

**Files:**
- Modify: `eu-dss-ui/src/services/backendApi.ts`

**Interfaces:**
- Produces: `ValidationKind = 'VALIDATED' | 'DETACHED_CONTENT_REQUIRED' | 'NOT_A_SIGNATURE'`; `ValidationResponse.kind: ValidationKind`
- Produces: `backendApi.validate(documentBase64: string, opts?: { documentName?; detachedContentBase64?; detachedContentName? })`

- [ ] **Step 1: Add the kind type + field**

In `eu-dss-ui/src/services/backendApi.ts`, change the `ValidationResponse` interface (lines 83-87) to:

```ts
export type ValidationKind = 'VALIDATED' | 'DETACHED_CONTENT_REQUIRED' | 'NOT_A_SIGNATURE';

export interface ValidationResponse {
  kind: ValidationKind;
  signatureCount: number;
  signatures: SignatureSummary[];
  simpleReportXml: string | null;
}

/** Optional second document + names for validating a DETACHED signature. */
export interface ValidateOptions {
  documentName?: string;
  detachedContentBase64?: string;
  detachedContentName?: string;
}
```

- [ ] **Step 2: Extend the `validate` client** (keep `validate(base64)` working)

In `eu-dss-ui/src/services/backendApi.ts`, replace the `validate` entry (lines 143-144) with:

```ts
  validate: (documentBase64: string, opts?: ValidateOptions) =>
    postJson<ValidationResponse>('/validate', {
      documentBase64,
      documentName: opts?.documentName,
      detachedContentBase64: opts?.detachedContentBase64,
      detachedContentName: opts?.detachedContentName,
    }),
```

(`JSON.stringify` drops `undefined` fields, so single-file callers are unchanged on the wire.)

- [ ] **Step 3: Typecheck + build**

Run: `cd eu-dss-ui && npm run build`
Expected: PASS. Existing callers `backendApi.validate(base64)` (`selfTest.ts:80`, `SignWorkspace.tsx:136`, `ValidatePage.tsx:377`, `DeepLinkVerifyModal.tsx:179`) still typecheck (opts optional; new `kind` field is additive).

- [ ] **Step 4: Commit**

```bash
git add eu-dss-ui/src/services/backendApi.ts
git commit  # message: "feat(ui): validate() accepts detached content + ValidationKind" + trailers
```

---

## Task 4: UI — remove XAdES-detached from the signer

**Files:**
- Modify: `eu-dss-ui/src/services/backendApi.ts`
- Modify: `eu-dss-ui/src/components/SignWorkspace.tsx`
- Modify: `eu-dss-ui/src/i18n/dict.ts`

**Interfaces:**
- Produces: `SignatureForm = 'PADES' | 'ASIC_E' | 'XADES_ENVELOPING'`

- [ ] **Step 1: Narrow the `SignatureForm` union**

In `eu-dss-ui/src/services/backendApi.ts`, change the comment + type (lines 42-50). Remove the `XADES_DETACHED` bullet (line 48) and change line 50 to:

```ts
export type SignatureForm = 'PADES' | 'ASIC_E' | 'XADES_ENVELOPING';
```

- [ ] **Step 2: Remove the option, label case, and note in `SignWorkspace.tsx`**

(a) `FORM_OPTIONS` (lines 27-33): delete the entry `{ value: 'XADES_DETACHED', labelKey: 'sign.form.xadesDet' },` (line 32).

(b) `formLabel` (lines 58-69): delete the case (lines 66-67):

```ts
    case 'XADES_DETACHED':
      return t('sign.form.xadesDet');
```

(The switch over the now 3-member `SignatureForm` stays exhaustive.)

(c) Delete the detached note block (lines 693-698):

```tsx
                  {doc.signatureForm === 'XADES_DETACHED' && (
                    <div className="doc-detached-note">
                      <Icon.alert size={12} />
                      {t('sign.docs.detachedNote')}
                    </div>
                  )}
```

- [ ] **Step 3: Remove the now-unused i18n keys**

In `eu-dss-ui/src/i18n/dict.ts`, delete these 4 lines:
- FR `'sign.form.xadesDet': 'XAdES détaché',` (line 127)
- FR `'sign.docs.detachedNote': '...',` (line 139)
- EN `'sign.form.xadesDet': 'XAdES detached',` (line 527)
- EN `'sign.docs.detachedNote': '...',` (line 538)

- [ ] **Step 4: Typecheck + build**

Run: `cd eu-dss-ui && npm run build`
Expected: PASS with **no** remaining reference to `XADES_DETACHED`, `sign.form.xadesDet`, or `sign.docs.detachedNote`. (If `tsc` flags a leftover usage, remove it — the union narrowing makes every stale reference a compile error.)

- [ ] **Step 5: Commit**

```bash
git add eu-dss-ui/src/services/backendApi.ts eu-dss-ui/src/components/SignWorkspace.tsx eu-dss-ui/src/i18n/dict.ts
git commit  # message: "feat(ui): remove XAdES-detached from the signing menu" + trailers
```

---

## Task 5: UI — smart verify zone (detached pair + clear deep-link limit)

**Files:**
- Modify: `eu-dss-ui/src/components/ValidatePage.tsx`
- Modify: `eu-dss-ui/src/components/DeepLinkVerifyModal.tsx`
- Modify: `eu-dss-ui/src/i18n/dict.ts`

**Interfaces:**
- Consumes: `backendApi.validate(base64, opts?)` and `ValidationResponse.kind` (Task 3).

- [ ] **Step 1: Add the verify/deep-link i18n keys (FR + EN)**

In `eu-dss-ui/src/i18n/dict.ts`, add to the **FR** block (near the other `verify.*` keys, ~line 265):

```ts
  'verify.detached.title': 'Signature détachée',
  'verify.detached.hint': 'Cette signature ne contient pas le document. Ajoutez le document source d’origine pour vérifier le couple.',
  'verify.notSig.title': 'Ce fichier n’est pas une signature',
  'verify.notSig.hint': 'Aucune signature trouvée. S’il s’agit du document source, ajoutez son fichier de signature (.p7s, .xml…).',
  'verify.addSecondFile': 'Déposer le second fichier, ou le choisir',
  'verify.chooseSecond': 'Choisir le fichier',
  'deeplinkVerify.detachedUnsupported': 'Signature détachée : la vérification par lien ne la prend pas en charge. Ouvrez l’application et utilisez l’onglet « Vérifier » avec le document source.',
```

And the matching **EN** block (near the EN `verify.*` keys, ~line 660):

```ts
  'verify.detached.title': 'Detached signature',
  'verify.detached.hint': 'This signature does not contain the document. Add the original source document to verify the pair.',
  'verify.notSig.title': 'This file is not a signature',
  'verify.notSig.hint': 'No signature found. If this is the source document, add its signature file (.p7s, .xml…).',
  'verify.addSecondFile': 'Drop the second file, or choose one',
  'verify.chooseSecond': 'Choose file',
  'deeplinkVerify.detachedUnsupported': 'Detached signature: link verification does not support it. Open the app and use the “Verify” tab with the source document.',
```

- [ ] **Step 2: Replace the `ValidatePage` main component with the state machine**

In `eu-dss-ui/src/components/ValidatePage.tsx`, replace the whole `export function ValidatePage() { ... }` (lines 347-529) with:

```tsx
export function ValidatePage() {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const secondInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [secondFile, setSecondFile] = useState<File | null>(null);
  // What the backend asked for after the first pass: a source document, a signature file, or nothing.
  const [need, setNeed] = useState<'source' | 'signature' | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function clearAll() {
    setFile(null);
    setSecondFile(null);
    setNeed(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
    if (secondInputRef.current) secondInputRef.current.value = '';
  }

  function pickFile(chosen: File | undefined) {
    if (!chosen) return;
    setFile(chosen);
    setSecondFile(null);
    setNeed(null);
    setResult(null);
    setError(null);
  }

  function recordHistory(res: ValidationResponse, name: string, sizeBytes: number) {
    try {
      history.add({
        kind: 'verify',
        name,
        format: res.signatures?.[0]?.signatureFormat ?? '',
        sizeBytes,
        verdict: overallVariant(res) === 'ok' ? 'TOTAL_PASSED' : res.signatures?.[0]?.indication ?? '',
        atIso: new Date().toISOString(),
      });
    } catch {
      // logging failure must never propagate
    }
  }

  // First pass: classify the dropped file. Self-contained → show result; otherwise ask for file #2.
  async function verifyPrimary() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setError(null);
    setNeed(null);
    try {
      const base64 = await fileToBase64(file);
      const res = await backendApi.validate(base64, { documentName: file.name });
      if (res.kind === 'DETACHED_CONTENT_REQUIRED') { setNeed('source'); return; }
      if (res.kind === 'NOT_A_SIGNATURE') { setNeed('signature'); return; }
      setResult(res);
      recordHistory(res, file.name, file.size);
    } catch (e) {
      setError((e as Error).message ?? t('common.unknownError'));
    } finally {
      setBusy(false);
    }
  }

  // Second pass: we have the pair. Roles depend on which file the backend asked for.
  async function verifyPair(second: File) {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const primaryB64 = await fileToBase64(file);
      const secondB64 = await fileToBase64(second);
      const res =
        need === 'source'
          ? // file = the signature, second = the original source document
            await backendApi.validate(primaryB64, {
              documentName: file.name,
              detachedContentBase64: secondB64,
              detachedContentName: second.name,
            })
          : // need === 'signature': file = the source document, second = the signature file
            await backendApi.validate(secondB64, {
              documentName: second.name,
              detachedContentBase64: primaryB64,
              detachedContentName: file.name,
            });
      setResult(res);
      recordHistory(res, need === 'source' ? file.name : second.name, file.size + second.size);
    } catch (e) {
      setError((e as Error).message ?? t('common.unknownError'));
    } finally {
      setBusy(false);
    }
  }

  function pickSecondFile(chosen: File | undefined) {
    if (!chosen) return;
    setSecondFile(chosen);
    void verifyPair(chosen);
  }

  return (
    <div className="verifier-root rise" key="verify">
      {/* ── Page header ── */}
      <div className="verifier-header">
        <h2 className="signer-title">{t('verify.title')}</h2>
        <p className="signer-subtitle">{t('verify.subtitle')}</p>
      </div>

      {/* hidden file inputs */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.asice,.asics,.p7s,.p7m,.xml,.scs"
        style={{ display: 'none' }}
        onChange={(e) => pickFile(e.target.files?.[0])}
      />
      <input
        ref={secondInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => pickSecondFile(e.target.files?.[0])}
      />

      {/* ── Primary drop / file row ── */}
      {!file ? (
        <div
          className={`vd-dropzone${dragOver ? ' vd-dropzone--over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
        >
          <span className="vd-dz-icon-tile"><Icon.upload size={20} /></span>
          <div className="vd-dz-text">
            <div className="vd-dz-title">{t('verify.dropTitle')}</div>
            <div className="vd-dz-hint">{t('verify.dropHint')}</div>
          </div>
          <button
            className="vd-dz-btn"
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
            tabIndex={-1}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
            {t('verify.chooseFile')}
          </button>
        </div>
      ) : (
        <div className="vd-file-row">
          <div className="fic">{fileKind(file.name).ext}</div>
          <div className="fmeta">
            <div className="fname">{file.name}</div>
            <div className="fsub"><span>{formatBytes(file.size)} · {t('verify.readyToVerify')}</span></div>
          </div>
          <div className="vd-file-actions">
            {need === null && result === null && (
              <Btn
                onClick={verifyPrimary}
                disabled={busy}
                icon={busy ? <span className="spinner" /> : <Icon.shieldCheck size={16} />}
              >
                {busy ? t('verify.verifying') : t('common.verify')}
              </Btn>
            )}
            {result !== null && (
              <Btn variant="ghost" onClick={clearAll} icon={<Icon.refresh size={15} />}>
                {t('verify.reset')}
              </Btn>
            )}
            <button className="x-btn" title={t('verify.removeFile')} onClick={clearAll}>
              <Icon.x size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ── Second-file prompt (detached pair / source-first) ── */}
      {file && need !== null && result === null && (
        <>
          <Banner
            kind="info"
            icon={<Icon.alert size={20} />}
            title={need === 'source' ? t('verify.detached.title') : t('verify.notSig.title')}
          >
            {need === 'source' ? t('verify.detached.hint') : t('verify.notSig.hint')}
          </Banner>

          {secondFile ? (
            <div className="vd-file-row">
              <div className="fic">{fileKind(secondFile.name).ext}</div>
              <div className="fmeta">
                <div className="fname">{secondFile.name}</div>
                <div className="fsub">
                  <span>{formatBytes(secondFile.size)}{busy ? ` · ${t('verify.verifying')}` : ''}</span>
                </div>
              </div>
              <div className="vd-file-actions">
                <button
                  className="x-btn"
                  title={t('verify.removeFile')}
                  onClick={() => { setSecondFile(null); if (secondInputRef.current) secondInputRef.current.value = ''; }}
                >
                  <Icon.x size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div
              className={`vd-dropzone${dragOver ? ' vd-dropzone--over' : ''}`}
              onClick={() => secondInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); pickSecondFile(e.dataTransfer.files?.[0]); }}
            >
              <span className="vd-dz-icon-tile"><Icon.upload size={20} /></span>
              <div className="vd-dz-text">
                <div className="vd-dz-title">{t('verify.addSecondFile')}</div>
                <div className="vd-dz-hint">{need === 'source' ? t('verify.detached.hint') : t('verify.notSig.hint')}</div>
              </div>
              <button
                className="vd-dz-btn"
                onClick={(e) => { e.stopPropagation(); secondInputRef.current?.click(); }}
                tabIndex={-1}
              >
                {t('verify.chooseSecond')}
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Error banner ── */}
      {error && (
        <Banner kind="danger" icon={<Icon.alert size={20} />} title={t('verify.failTitle')}>
          {error}
        </Banner>
      )}

      {/* ── Result section ── */}
      {result !== null && (
        <div className="vd-result rise">
          <VerdictBanner result={result} />

          {result.signatures.length > 0 && result.signatures.map((s) => (
            <div key={s.signatureId} className="vd-sig-block">
              <div className="vd-sig-cols">
                <SignataireCard s={s} />
                <ChecksCard s={s} />
              </div>
            </div>
          ))}

          <div className="vd-footer-note">
            <span dangerouslySetInnerHTML={{ __html: t('verify.footerNote', { n: result.signatureCount, date: todayFR() }) }} />
          </div>

          <ReportActions xml={result.simpleReportXml} />

          <details className="disclosure">
            <summary>
              <span className="chev"><Icon.chevR size={16} /></span>
              {t('verify.report.disclosure')}
            </summary>
            <div style={{ paddingBottom: 16 }}>
              <XmlReport xml={result.simpleReportXml} t={t} />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Surface the deep-link limitation in `DeepLinkVerifyModal.tsx`**

In `runValidate` (the `backendApi.validate` block), insert the detached guard between the stale-run check and `setResult(res)` (originally lines 184-185):

```ts
    if (runId !== runIdRef.current) return;
    if (res.kind === 'DETACHED_CONTENT_REQUIRED') {
      // Link verification carries one document; detached pairs are in-app only (by design).
      fail(t('deeplinkVerify.detachedUnsupported'), runId);
      return;
    }
    setResult(res);
```

- [ ] **Step 4: Typecheck + build**

Run: `cd eu-dss-ui && npm run build`
Expected: PASS.

- [ ] **Step 5: Manual smoke with the real CANUT files**

Run: `cd eu-dss-ui && npm run tauri dev`. In the **Vérifier** tab, confirm:
1. Drop `2025_DC_ECS_BPU_FINAL_V2.xlsx.p7s` (attached CAdES) alone → result shown directly (self-contained).
2. Drop `2025_DC_ECS_BPU_FINAL_V2_XADES.xml` (detached) alone → "Signature détachée" banner + second drop-zone → add `2025_DC_ECS_BPU_FINAL_V2.xlsx` → valid result.
3. Drop `2025_DC_ECS_BPU_FINAL_V2.xlsx` (plain) alone → "Ce fichier n'est pas une signature" → add the `.xml` → valid result (role swap).
4. Drop the `.xml` + a wrong document → result is not "valid" (integrity fails), message is clear.

- [ ] **Step 6: Commit**

```bash
git add eu-dss-ui/src/components/ValidatePage.tsx eu-dss-ui/src/components/DeepLinkVerifyModal.tsx eu-dss-ui/src/i18n/dict.ts
git commit  # message: "feat(ui): smart verify zone for detached signature pairs" + trailers
```

---

## Task 6: Docs — README + deep-link integration

**Files:**
- Modify: `README.md`
- Modify: `docs/deeplink-integration.md`

- [ ] **Step 1: README — note detached verification + that detached generation is gone**

In `README.md`, in the "Comment ça marche" area (after the signing-flow block, around line 59-61), add a short paragraph:

```markdown
> **Vérification.** L'onglet « Vérifier » accepte les signatures **auto-suffisantes** (PAdES, ASiC, XAdES enveloppant, CAdES attaché) en un seul fichier. Pour une signature **détachée** (le fichier de signature ne contient pas le document), l'application détecte le cas et réclame le **document source** pour valider le couple. L'application ne **produit** que des signatures auto-suffisantes (PAdES / ASiC-E / XAdES enveloppant).
```

- [ ] **Step 2: deep-link doc — document the mono-file limit of `eudss://verify`**

In `docs/deeplink-integration.md`, under the `### eudss://verify` section (around line 76-79), add a note:

```markdown
> **Limite — signatures détachées.** `eudss://verify` ne transporte qu'un seul document (`doc_url`) et ne valide donc que des signatures **auto-suffisantes** (PAdES, ASiC, XAdES enveloppant, CAdES attaché). Une signature **détachée** (couple signature + document source) n'est pas prise en charge par le lien : ouvrez l'application et utilisez l'onglet « Vérifier », qui réclamera le second fichier.
```

- [ ] **Step 3: Sanity check the docs render**

Run: `rg -n "détach|Vérification|eudss://verify" README.md docs/deeplink-integration.md`
Expected: the new paragraphs are present and well-formed.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/deeplink-integration.md
git commit  # message: "docs: detached verification + deep-link verify limitation" + trailers
```

---

## Self-Review

**Spec coverage** (`docs/specs/2026-06-23-detached-signature-handling-design.md`):
- §4.1 Génération (retrait détaché) → Task 2 (backend) + Task 4 (UI). ✓
- §4.2 Détection backend (3 cas) → Task 1 (Step 6 classification). ✓
- §4.3 Backend `setDetachedContents` → Task 1 (Step 6). ✓
- §4.4 API REST (`detachedContentBase64` + `kind`, rétro-compatible) → Task 1 (Steps 5-7) + Task 3 (UI client). ✓
- §4.5 UI zone unique + inversion des rôles + DeepLinkVerifyModal limite → Task 5. ✓
- §4.6 Doc API → Task 6. ✓
- §5 Acceptance tests 1-7 → Task 1 tests + Task 5 Step 5 manual; test 8 (sign xlsx → .asice; menu sans détaché) → Task 4 + existing `AsicSignatureE2ETest`; test 9 (API rejette `XADES_DETACHED`) → Task 2 guard test. ✓
- D5 (keep XAdES enveloping) → preserved (enveloping bean/option untouched). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete content. ✓

**Type consistency:** `ValidationKind` values identical in Java (`ValidationResponseDto.ValidationKind`) and TS (`backendApi.ValidationKind`): `VALIDATED` / `DETACHED_CONTENT_REQUIRED` / `NOT_A_SIGNATURE`. Service method `validate(String,String,String,String)` matches the controller call and the TS `validate(documentBase64, opts)` field names (`documentName`, `detachedContentBase64`, `detachedContentName`). `SignatureForm` narrowed consistently in `backendApi.ts` and consumed in `SignWorkspace.tsx`. ✓

**Known implementation risk (pinned by tests):** the detached signal is `SubIndication.SIGNED_DATA_NOT_FOUND`. If DSS 6.4 emits a different sub-indication for missing detached content, `DocumentValidationServiceTest.detached_without_source_asks_for_content` fails at Task 1 Step 8 — adjust `needsDetachedContent(...)` accordingly before proceeding.
