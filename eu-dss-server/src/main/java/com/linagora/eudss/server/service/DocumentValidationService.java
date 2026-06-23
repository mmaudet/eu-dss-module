package com.linagora.eudss.server.service;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.dto.ValidationResponseDto.SignatureSummary;
import com.linagora.eudss.server.dto.ValidationResponseDto.ValidationKind;
import eu.europa.esig.dss.enumerations.Indication;
import eu.europa.esig.dss.enumerations.SubIndication;
import eu.europa.esig.dss.model.DSSDocument;
import eu.europa.esig.dss.model.InMemoryDocument;
import eu.europa.esig.dss.simplereport.SimpleReport;
import eu.europa.esig.dss.simplereport.SimpleReportFacade;
import eu.europa.esig.dss.spi.validation.CommonCertificateVerifier;
import eu.europa.esig.dss.validation.SignedDocumentValidator;
import eu.europa.esig.dss.validation.reports.Reports;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

    private static final Logger log = LoggerFactory.getLogger(DocumentValidationService.class);

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
        byte[] documentBytes = Base64.getDecoder().decode(documentBase64);
        if (documentBytes.length == 0) {
            return notASignature();
        }
        DSSDocument document = new InMemoryDocument(documentBytes,
                hasText(documentName) ? documentName : "document");

        SignedDocumentValidator validator;
        try {
            validator = SignedDocumentValidator.fromDocument(document);
        } catch (RuntimeException e) {
            // DSS does not recognise this file as any signature container (e.g. a plain .xlsx ZIP or corrupt bytes).
            log.warn("Unrecognised/invalid document during validation", e);
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
            return new ValidationResponseDto(ValidationKind.DETACHED_CONTENT_REQUIRED, null, 0, List.of(), null);
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
        String overallIndication = computeOverallIndication(simple);
        return new ValidationResponseDto(ValidationKind.VALIDATED, overallIndication, simple.getSignaturesCount(), summaries, marshalSimpleReport(reports));
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
        return new ValidationResponseDto(ValidationKind.NOT_A_SIGNATURE, null, 0, List.of(), null);
    }

    private static String computeOverallIndication(SimpleReport simple) {
        boolean allPassed = true;
        for (String sigId : simple.getSignatureIdList()) {
            Indication ind = simple.getIndication(sigId);
            if (ind == Indication.TOTAL_FAILED) {
                return "TOTAL_FAILED";
            }
            if (ind != Indication.TOTAL_PASSED) {
                allPassed = false;
            }
        }
        return allPassed ? "TOTAL_PASSED" : "INDETERMINATE";
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
            log.warn("Failed to marshal DSS simple report", e);
            return null;
        }
    }
}
