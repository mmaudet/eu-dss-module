package com.linagora.eudss.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.linagora.eudss.agent.config.AgentConfig;
import com.linagora.eudss.agent.dto.CertificateInfo;
import com.linagora.eudss.agent.service.LockedException;
import com.linagora.eudss.agent.service.TokenService;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import io.javalin.Javalin;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class AgentHttpSmokeTest {

    private Javalin app;
    private HttpClient http;
    private ObjectMapper json;
    private int port;
    private FakeToken token;

    /** Stub: session state in-memory, no real PKCS#11. */
    static class FakeToken extends TokenService {
        boolean unlocked = false;
        boolean failOpen = false;
        FakeToken(AgentConfig c) { super(c); }
        @Override public synchronized void unlock(char[] pin) {
            if (failOpen) throw new RuntimeException("PKCS11Exception: CKR_PIN_INCORRECT");
            unlocked = true;
        }
        @Override public synchronized void lock() { unlocked = false; }
        @Override public synchronized boolean isUnlocked() { return unlocked; }
        @Override public synchronized Long expiresInSeconds() { return unlocked ? 300L : null; }
        @Override public synchronized void touch() { }
        @Override public List<CertificateInfo> listCertificates() {
            if (!unlocked) throw new LockedException();
            return List.of(new CertificateInfo("stub-key-1", "Y2VydA==", List.of("Y2VydA=="),
                    "CN=stub", "CN=stub-ca", "1", "2024-01-01T00:00:00Z", "2034-01-01T00:00:00Z"));
        }
        @Override public byte[] signDigest(String keyId, byte[] d, DigestAlgorithm a) {
            if (!unlocked) throw new LockedException();
            if (!"stub-key-1".equals(keyId)) throw new IllegalArgumentException("unknown key");
            return new byte[]{0x01, 0x02, 0x03};
        }
    }

    @BeforeEach
    void setup() {
        AgentConfig cfg = new AgentConfig(Path.of("/nonexistent/driver"), 0, 0,
                List.of("http://localhost:5173"), null, false, 300);
        token = new FakeToken(cfg);
        app = AgentMain.buildApp(cfg, token).start(0);
        port = app.port();
        http = HttpClient.newHttpClient();
        json = new ObjectMapper();
    }

    @AfterEach
    void teardown() { app.stop(); }

    private HttpResponse<String> get(String path) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String path, String body) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void health_ok() throws Exception {
        assertThat(get("/rest/health").statusCode()).isEqualTo(200);
    }

    @Test
    void status_locked_by_default() throws Exception {
        HttpResponse<String> res = get("/rest/status");
        assertThat(res.statusCode()).isEqualTo(200);
        assertThat(res.body()).contains("\"unlocked\":false").contains("\"mode\":\"interactive\"");
    }

    @Test
    void certificates_and_sign_return_401_when_locked() throws Exception {
        assertThat(get("/rest/certificates").statusCode()).isEqualTo(401);
        String body = json.writeValueAsString(java.util.Map.of(
                "keyId", "stub-key-1", "digestBase64", "AA==", "digestAlgorithm", "SHA256"));
        HttpResponse<String> res = post("/rest/sign", body);
        assertThat(res.statusCode()).isEqualTo(401);
        assertThat(res.body()).contains("\"error\":\"locked\"");
    }

    @Test
    void unlock_then_certificates_and_sign_work() throws Exception {
        assertThat(post("/rest/unlock", "{\"pin\":\"1234\"}").statusCode()).isEqualTo(200);
        assertThat(get("/rest/status").body()).contains("\"unlocked\":true");

        HttpResponse<String> certs = get("/rest/certificates");
        assertThat(certs.statusCode()).isEqualTo(200);
        assertThat(certs.body()).contains("stub-key-1");

        String body = json.writeValueAsString(java.util.Map.of(
                "keyId", "stub-key-1",
                "digestBase64", Base64.getEncoder().encodeToString(new byte[]{0x10, 0x20}),
                "digestAlgorithm", "SHA256"));
        HttpResponse<String> sign = post("/rest/sign", body);
        assertThat(sign.statusCode()).isEqualTo(200);
        assertThat(sign.body()).contains("signatureValueBase64");
    }

    @Test
    void lock_relocks() throws Exception {
        post("/rest/unlock", "{\"pin\":\"1234\"}");
        assertThat(post("/rest/lock", "").statusCode()).isEqualTo(200);
        assertThat(get("/rest/status").body()).contains("\"unlocked\":false");
    }

    @Test
    void wrong_pin_returns_401_pin_incorrect() throws Exception {
        token.failOpen = true;
        HttpResponse<String> res = post("/rest/unlock", "{\"pin\":\"0000\"}");
        assertThat(res.statusCode()).isEqualTo(401);
        assertThat(res.body()).contains("\"error\":\"pin_incorrect\"");
    }

    @Test
    void sign_unknown_key_returns_400_when_unlocked() throws Exception {
        post("/rest/unlock", "{\"pin\":\"1234\"}");
        String body = json.writeValueAsString(java.util.Map.of(
                "keyId", "missing", "digestBase64", "AA==", "digestAlgorithm", "SHA256"));
        assertThat(post("/rest/sign", body).statusCode()).isEqualTo(400);
    }
}
