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
