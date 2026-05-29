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
