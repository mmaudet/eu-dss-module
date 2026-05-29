package com.linagora.eudss.server.web;

import com.linagora.eudss.server.dto.ValidationResponseDto;
import com.linagora.eudss.server.service.PdfValidationService;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/validate")
public class ValidationController {

    private final PdfValidationService service;

    public ValidationController(PdfValidationService service) {
        this.service = service;
    }

    public record ValidateRequest(@NotBlank String pdfBase64) {}

    @PostMapping
    public ValidationResponseDto validate(@RequestBody ValidateRequest req) {
        return service.validate(req.pdfBase64());
    }
}
