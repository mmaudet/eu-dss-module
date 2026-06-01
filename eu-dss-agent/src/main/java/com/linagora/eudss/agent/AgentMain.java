package com.linagora.eudss.agent;

import com.linagora.eudss.agent.config.AgentConfig;
import com.linagora.eudss.agent.dto.SignDigestRequest;
import com.linagora.eudss.agent.dto.SignDigestResponse;
import com.linagora.eudss.agent.dto.StatusResponse;
import com.linagora.eudss.agent.dto.UnlockRequest;
import com.linagora.eudss.agent.service.LockedException;
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

    private static final char[] TLS_KEYSTORE_PASSWORD =
            System.getenv().getOrDefault("EUDSS_AGENT_TLS_PASSWORD", "eudss-agent").toCharArray();

    public static void main(String[] args) {
        AgentConfig config = AgentConfig.load();
        TokenService tokenService = new TokenService(config);
        Runtime.getRuntime().addShutdownHook(new Thread(tokenService::close, "token-close"));

        if (config.headless()) {
            try {
                tokenService.unlock(config.pin().clone()); // headless auto-unlock; PIN intentionally retained for the agent lifetime (no UI to re-prompt)
                LOG.info("Headless mode: token auto-unlocked from EUDSS_AGENT_PIN (no idle-lock).");
            } catch (Exception e) {
                LOG.warn("Headless auto-unlock failed; agent starts LOCKED: {}", e.getMessage());
            }
        }

        Javalin app = buildApp(config, tokenService);
        if (config.tlsEnabled()) {
            app.start();
            LOG.info("eu-dss agent listening on https://localhost:{} (TLS) mode={} CORS {}",
                    config.port(), config.mode(), config.corsHosts());
        } else {
            app.start(config.port());
            LOG.info("eu-dss agent listening on http://localhost:{} (no TLS) mode={} CORS {}",
                    config.port(), config.mode(), config.corsHosts());
        }
    }

    public static Javalin buildApp(AgentConfig config, TokenService tokenService) {
        Javalin app = Javalin.create(cfg -> {
            cfg.bundledPlugins.enableCors(cors -> cors.addRule(rule -> config.corsHosts().forEach(rule::allowHost)));
            cfg.showJavalinBanner = false;
            if (config.tlsEnabled()) {
                try {
                    java.nio.file.Path ks = com.linagora.eudss.agent.tls.AgentTls.defaultKeystorePath();
                    com.linagora.eudss.agent.tls.AgentTls.ensureKeystore(ks, TLS_KEYSTORE_PASSWORD);
                    cfg.registerPlugin(new io.javalin.community.ssl.SslPlugin(ssl -> {
                        ssl.keystoreFromPath(ks.toString(), new String(TLS_KEYSTORE_PASSWORD));
                        ssl.insecure = false;
                        ssl.secure = true;
                        ssl.securePort = config.port();
                        ssl.http2 = false;
                    }));
                } catch (Exception e) {
                    throw new IllegalStateException("Failed to set up agent TLS keystore", e);
                }
            }
        });

        app.before(ctx -> ctx.header("Access-Control-Allow-Private-Network", "true"));

        app.get("/rest/health", ctx -> ctx.json(Map.of("status", "ok")));

        app.get("/rest/status", ctx -> ctx.json(new StatusResponse(
                tokenService.isUnlocked(), tokenService.expiresInSeconds(), config.mode())));

        app.post("/rest/unlock", ctx -> {
            UnlockRequest req = ctx.bodyAsClass(UnlockRequest.class);
            if (req.pin() == null || req.pin().isEmpty()) {
                ctx.status(HttpStatus.BAD_REQUEST).json(Map.of("error", "bad_request", "message", "pin required"));
                return;
            }
            char[] pin = req.pin().toCharArray();
            try {
                tokenService.unlock(pin);
                ctx.json(new StatusResponse(true, tokenService.expiresInSeconds(), config.mode()));
            } catch (Exception e) {
                mapTokenError(ctx, e);
            }
        });

        app.post("/rest/lock", ctx -> {
            tokenService.lock();
            ctx.json(Map.of("status", "locked"));
        });

        app.get("/rest/certificates", ctx -> {
            try {
                ctx.json(Map.of("certificates", tokenService.listCertificates()));
            } catch (LockedException e) {
                locked(ctx);
            } catch (Exception e) {
                LOG.error("Failed to list certificates", e);
                mapTokenError(ctx, e);
            }
        });

        app.post("/rest/sign", ctx -> {
            SignDigestRequest req = ctx.bodyAsClass(SignDigestRequest.class);
            try {
                byte[] digest = Base64.getDecoder().decode(req.digestBase64());
                DigestAlgorithm algo = DigestAlgorithm.valueOf(req.digestAlgorithm());
                byte[] sigValue = tokenService.signDigest(req.keyId(), digest, algo);
                ctx.json(new SignDigestResponse(Base64.getEncoder().encodeToString(sigValue)));
            } catch (LockedException e) {
                locked(ctx);
            } catch (IllegalArgumentException e) {
                ctx.status(HttpStatus.BAD_REQUEST).json(Map.of("error", "bad_request", "message", String.valueOf(e.getMessage())));
            } catch (Exception e) {
                LOG.error("Sign failure", e);
                mapTokenError(ctx, e);
            }
        });

        app.exception(Exception.class, (e, ctx) -> {
            LOG.error("Unhandled error", e);
            ctx.status(HttpStatus.INTERNAL_SERVER_ERROR).json(Map.of("error", "internal", "message", String.valueOf(e.getMessage())));
        });

        return app;
    }

    private static void locked(io.javalin.http.Context ctx) {
        ctx.status(HttpStatus.UNAUTHORIZED).json(Map.of("error", "locked", "message", "PIN required: call /rest/unlock"));
    }

    /** Best-effort PKCS#11 error mapping; never auto-retries. */
    private static void mapTokenError(io.javalin.http.Context ctx, Exception e) {
        String msg = deepMessage(e);
        LOG.warn("PKCS#11 token operation failed (mapping to HTTP): {}", msg, e);
        if (msg.contains("CKR_PIN_INCORRECT")) {
            ctx.status(HttpStatus.UNAUTHORIZED).json(Map.of("error", "pin_incorrect", "message", "Incorrect PIN"));
        } else if (msg.contains("CKR_PIN_LOCKED") || msg.contains("CKR_PIN_EXPIRED")) {
            ctx.status(HttpStatus.LOCKED).json(Map.of("error", "pin_locked", "message", "Card PIN is locked"));
        } else {
            ctx.status(HttpStatus.SERVICE_UNAVAILABLE).json(Map.of("error", "token_unavailable", "message", msg));
        }
    }

    private static String deepMessage(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = t; c != null && c != c.getCause(); c = c.getCause()) {
            if (c.getMessage() != null) sb.append(c.getMessage()).append(" | ");
        }
        return sb.toString().replaceAll(" \\| $", "");
    }

    private AgentMain() {}
}
