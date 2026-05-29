package com.linagora.eudss.agent;

import com.linagora.eudss.agent.config.AgentConfig;
import com.linagora.eudss.agent.dto.SignDigestRequest;
import com.linagora.eudss.agent.dto.SignDigestResponse;
import com.linagora.eudss.agent.service.TokenService;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import io.javalin.Javalin;
import io.javalin.http.HttpStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Base64;
import java.util.Map;

public final class AgentMain {

    private static final Logger LOG = LoggerFactory.getLogger(AgentMain.class);

    public static void main(String[] args) {
        AgentConfig config = AgentConfig.load();
        TokenService tokenService = new TokenService(config);
        Runtime.getRuntime().addShutdownHook(new Thread(tokenService::close, "token-close"));

        Javalin app = buildApp(config, tokenService);
        app.start(config.port());
        LOG.info("eu-dss agent listening on http://localhost:{} (CORS hosts: {})", config.port(), config.corsHosts());
    }

    public static Javalin buildApp(AgentConfig config, TokenService tokenService) {
        Javalin app = Javalin.create(cfg -> {
            cfg.bundledPlugins.enableCors(cors -> cors.addRule(rule -> {
                config.corsHosts().forEach(rule::allowHost);
            }));
            cfg.showJavalinBanner = false;
        });

        app.get("/rest/health", ctx -> ctx.json(Map.of("status", "ok")));

        app.get("/rest/certificates", ctx -> {
            try {
                ctx.json(Map.of("certificates", tokenService.listCertificates()));
            } catch (Exception e) {
                LOG.error("Failed to list certificates", e);
                ctx.status(HttpStatus.SERVICE_UNAVAILABLE).json(Map.of(
                        "error", "token_unavailable",
                        "message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()
                ));
            }
        });

        app.post("/rest/sign", ctx -> {
            SignDigestRequest req = ctx.bodyAsClass(SignDigestRequest.class);
            try {
                byte[] digest = Base64.getDecoder().decode(req.digestBase64());
                DigestAlgorithm algo = DigestAlgorithm.valueOf(req.digestAlgorithm());
                byte[] sigValue = tokenService.signDigest(req.keyId(), digest, algo);
                ctx.json(new SignDigestResponse(Base64.getEncoder().encodeToString(sigValue)));
            } catch (IllegalArgumentException e) {
                ctx.status(HttpStatus.BAD_REQUEST).json(Map.of("error", "bad_request", "message", e.getMessage()));
            } catch (Exception e) {
                LOG.error("Sign failure", e);
                ctx.status(HttpStatus.INTERNAL_SERVER_ERROR).json(Map.of("error", "sign_failed", "message", e.getMessage()));
            }
        });

        app.exception(Exception.class, (e, ctx) -> {
            LOG.error("Unhandled error", e);
            ctx.status(HttpStatus.INTERNAL_SERVER_ERROR).json(Map.of("error", "internal", "message", e.getMessage()));
        });

        return app;
    }

    private AgentMain() {}
}
