package com.linagora.eudss.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.linagora.eudss.agent.config.AgentConfig;
import com.linagora.eudss.agent.dto.CertificateInfo;
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

    @BeforeEach
    void setup() {
        AgentConfig cfg = new AgentConfig(
                Path.of("/nonexistent/driver"),
                0,
                0,
                List.of("localhost:5173"),
                "0000".toCharArray(),
                false
        );
        TokenService stub = new TokenService(cfg) {
            @Override
            public List<CertificateInfo> listCertificates() {
                return List.of(new CertificateInfo(
                        "stub-key-1",
                        "Y2VydA==",
                        List.of("Y2VydA=="),
                        "CN=stub",
                        "CN=stub-ca",
                        "1",
                        "2024-01-01T00:00:00Z",
                        "2034-01-01T00:00:00Z"
                ));
            }

            @Override
            public byte[] signDigest(String keyId, byte[] digestBytes, DigestAlgorithm algorithm) {
                if (!"stub-key-1".equals(keyId)) {
                    throw new IllegalArgumentException("unknown key");
                }
                return new byte[]{0x01, 0x02, 0x03};
            }
        };
        app = AgentMain.buildApp(cfg, stub).start(0);
        port = app.port();
        http = HttpClient.newHttpClient();
        json = new ObjectMapper();
    }

    @AfterEach
    void teardown() {
        app.stop();
    }

    @Test
    void health_endpoint_returns_ok() throws Exception {
        HttpResponse<String> res = http.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/rest/health")).GET().build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertThat(res.statusCode()).isEqualTo(200);
        assertThat(res.body()).contains("\"status\":\"ok\"");
    }

    @Test
    void certificates_endpoint_returns_list() throws Exception {
        HttpResponse<String> res = http.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/rest/certificates")).GET().build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertThat(res.statusCode()).isEqualTo(200);
        assertThat(res.body()).contains("stub-key-1").contains("CN=stub");
    }

    @Test
    void sign_endpoint_returns_signature_value() throws Exception {
        String body = json.writeValueAsString(java.util.Map.of(
                "keyId", "stub-key-1",
                "digestBase64", Base64.getEncoder().encodeToString(new byte[]{0x10, 0x20}),
                "digestAlgorithm", "SHA256"
        ));
        HttpResponse<String> res = http.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/rest/sign"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertThat(res.statusCode()).isEqualTo(200);
        assertThat(res.body()).contains("signatureValueBase64");
        assertThat(res.body()).contains(Base64.getEncoder().encodeToString(new byte[]{0x01, 0x02, 0x03}));
    }

    @Test
    void sign_endpoint_returns_400_on_unknown_key() throws Exception {
        String body = json.writeValueAsString(java.util.Map.of(
                "keyId", "missing",
                "digestBase64", "AA==",
                "digestAlgorithm", "SHA256"
        ));
        HttpResponse<String> res = http.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/rest/sign"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertThat(res.statusCode()).isEqualTo(400);
    }
}
