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
