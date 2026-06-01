# PIN at Signing Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the card PIN from eager-at-agent-startup to signing-time, via an explicit unlock/lock/status session on the agent (idle-TTL) and a PIN modal + lock indicator in the UI.

**Architecture:** The agent keeps an open+logged-in PKCS#11 token only while "unlocked"; `/rest/unlock` opens it with a UI-supplied PIN, an idle timer (`EUDSS_PIN_SESSION_TTL`, default 300s) re-locks it, `/rest/lock` re-locks now, `/rest/status` reports state. `/rest/certificates` and `/rest/sign` return 401 `locked` when locked. `EUDSS_AGENT_PIN` stays as an optional headless auto-unlock (no idle-lock). The browser collects the PIN and sends it over HTTPS-localhost only.

**Tech Stack:** Java 21 + Javalin 6 + DSS `dss-token` (agent) ; Vite + React 19 + TypeScript (UI) ; JUnit 5 + AssertJ (agent tests).

**Spec:** `docs/superpowers/specs/2026-06-01-pin-at-signing-time-design.md`

---

## File Structure

**Agent (`eu-dss-agent`):**
- `config/AgentConfig.java` — MODIFY: `pin` optional (nullable), add `pinSessionTtlSeconds`, `headless()`, `mode()`; drop console prompt.
- `dto/UnlockRequest.java` — CREATE.
- `dto/StatusResponse.java` — CREATE.
- `service/TokenService.java` — MODIFY: session state (`unlock`/`lock`/`isUnlocked`/`expiresInSeconds`/`touch`), idle scheduler, testable open/close seams, PIN zeroize.
- `service/LockedException.java` — CREATE: thrown when an op needs an unlocked token.
- `AgentMain.java` — MODIFY: new endpoints, 401 gating, error mapping, headless auto-unlock.
- Tests: `config/AgentConfigDefaultsTest.java` (MODIFY), `service/TokenServiceSessionTest.java` (CREATE), `AgentHttpSmokeTest.java` (MODIFY).

**Server (`eu-dss-server`):**
- `FullStackE2ETest.java` — MODIFY: unlock the stubbed agent before signing.

**UI (`eu-dss-ui`):**
- `services/agentApi.ts` — MODIFY: typed `AgentError`, `unlock`/`lock`/`getStatus`.
- `components/PinModal.tsx` — CREATE.
- `components/SignWorkspace.tsx` — MODIFY: status state, lock indicator + Lock button, PIN modal, unlock-before-sign + 401 handling.

---

## Task 1: AgentConfig — optional PIN, TTL, mode

**Files:**
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/config/AgentConfig.java`
- Test: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/config/AgentConfigDefaultsTest.java`

- [ ] **Step 1: Update the defaults test (failing) to the new shape**

Replace the whole body of `AgentConfigDefaultsTest` with:

```java
package com.linagora.eudss.agent.config;

import org.junit.jupiter.api.Test;
import java.util.Map;
import static org.assertj.core.api.Assertions.assertThat;

class AgentConfigDefaultsTest {

    @Test
    void defaults_interactive_no_pin_ttl_300() {
        AgentConfig cfg = AgentConfig.fromEnv(Map.of(), "Mac OS X");
        assertThat(cfg.slotListIndex()).isEqualTo(0);
        assertThat(cfg.pkcs11Driver().toString()).isEqualTo("/Library/SCMiddleware/libidop11.dylib");
        assertThat(cfg.port()).isEqualTo(9795);
        assertThat(cfg.corsHosts()).contains("http://localhost:5173");
        assertThat(cfg.pin()).isNull();
        assertThat(cfg.headless()).isFalse();
        assertThat(cfg.mode()).isEqualTo("interactive");
        assertThat(cfg.pinSessionTtlSeconds()).isEqualTo(300);
    }

    @Test
    void env_pin_makes_it_headless() {
        AgentConfig cfg = AgentConfig.fromEnv(Map.of("EUDSS_AGENT_PIN", "1234"), "Mac OS X");
        assertThat(cfg.pin()).containsExactly('1', '2', '3', '4');
        assertThat(cfg.headless()).isTrue();
        assertThat(cfg.mode()).isEqualTo("headless");
    }

    @Test
    void env_overrides_slot_driver_port_ttl() {
        AgentConfig cfg = AgentConfig.fromEnv(
                Map.of("EUDSS_PKCS11_SLOT", "1", "EUDSS_PKCS11_DRIVER", "/custom/lib.so",
                        "EUDSS_AGENT_PORT", "9999", "EUDSS_PIN_SESSION_TTL", "60"),
                "Mac OS X");
        assertThat(cfg.slotListIndex()).isEqualTo(1);
        assertThat(cfg.pkcs11Driver().toString()).isEqualTo("/custom/lib.so");
        assertThat(cfg.port()).isEqualTo(9999);
        assertThat(cfg.pinSessionTtlSeconds()).isEqualTo(60);
    }

    @Test
    void default_driver_is_os_specific() {
        assertThat(AgentConfig.defaultDriver("Linux")).isEqualTo("/usr/lib/libidop11.so");
        assertThat(AgentConfig.defaultDriver("Windows 11")).isEqualTo("C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll");
        assertThat(AgentConfig.defaultDriver("Mac OS X")).isEqualTo("/Library/SCMiddleware/libidop11.dylib");
    }
}
```

- [ ] **Step 2: Run the test, verify it fails to compile**

Run: `mvn -f eu-dss-agent/pom.xml -q test-compile`
Expected: FAIL — `fromEnv(Map,String)` not found, `pinSessionTtlSeconds()`/`headless()`/`mode()` not found.

- [ ] **Step 3: Rewrite AgentConfig**

Replace the entire `AgentConfig.java` with:

```java
package com.linagora.eudss.agent.config;

import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

public record AgentConfig(
        Path pkcs11Driver,
        int slotListIndex,
        int port,
        List<String> corsHosts,
        char[] pin,                 // null in interactive mode (no EUDSS_AGENT_PIN)
        boolean tlsEnabled,
        int pinSessionTtlSeconds
) {
    private static final String DEFAULT_DRIVER_MAC = "/Library/SCMiddleware/libidop11.dylib";
    private static final String DEFAULT_DRIVER_LINUX = "/usr/lib/libidop11.so";
    // IDOPTE/ChamberSign Windows middleware: idoPKCS.dll under "Smart Card Middleware\bin" (see cea555d).
    private static final String DEFAULT_DRIVER_WIN = "C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll";

    public static AgentConfig load() {
        return fromEnv(System.getenv(), System.getProperty("os.name", ""));
    }

    /** Pure config resolution from explicit inputs (package-private for tests). PIN comes only from
     *  EUDSS_AGENT_PIN now (no console prompt); absent => interactive (locked until /rest/unlock). */
    static AgentConfig fromEnv(Map<String, String> env, String osName) {
        String driver = env.getOrDefault("EUDSS_PKCS11_DRIVER", defaultDriver(osName));
        int slot = Integer.parseInt(env.getOrDefault("EUDSS_PKCS11_SLOT", "0"));
        int port = Integer.parseInt(env.getOrDefault("EUDSS_AGENT_PORT", "9795"));
        String origins = env.getOrDefault("EUDSS_CORS_HOSTS",
                "http://localhost:5173,http://localhost:8080,http://localhost:4173");
        boolean tls = !"false".equalsIgnoreCase(env.getOrDefault("EUDSS_AGENT_TLS", "true"));
        int ttl = Integer.parseInt(env.getOrDefault("EUDSS_PIN_SESSION_TTL", "300"));
        String envPin = env.get("EUDSS_AGENT_PIN");
        char[] pin = (envPin != null && !envPin.isBlank()) ? envPin.toCharArray() : null;
        return new AgentConfig(
                Path.of(driver),
                slot,
                port,
                Arrays.stream(origins.split(",")).map(String::trim).filter(s -> !s.isBlank()).toList(),
                pin,
                tls,
                ttl
        );
    }

    static String defaultDriver(String osName) {
        String os = osName.toLowerCase();
        if (os.contains("mac")) return DEFAULT_DRIVER_MAC;
        if (os.contains("win")) return DEFAULT_DRIVER_WIN;
        return DEFAULT_DRIVER_LINUX;
    }

    /** Headless = an env PIN was supplied → auto-unlock at startup, no idle-lock. */
    public boolean headless() {
        return pin != null && pin.length > 0;
    }

    public String mode() {
        return headless() ? "headless" : "interactive";
    }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=AgentConfigDefaultsTest test`
Expected: PASS (4 tests). (Other modules won't compile yet — that's fine, fixed in later tasks; run only this test class.)

- [ ] **Step 5: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/config/AgentConfig.java eu-dss-agent/src/test/java/com/linagora/eudss/agent/config/AgentConfigDefaultsTest.java
git commit -m "feat(agent): AgentConfig optional PIN + session TTL + mode (drop startup console prompt)"
```

---

## Task 2: DTOs for unlock + status

**Files:**
- Create: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/dto/UnlockRequest.java`
- Create: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/dto/StatusResponse.java`

- [ ] **Step 1: Create UnlockRequest**

```java
package com.linagora.eudss.agent.dto;

public record UnlockRequest(String pin) {}
```

- [ ] **Step 2: Create StatusResponse**

```java
package com.linagora.eudss.agent.dto;

public record StatusResponse(boolean unlocked, Long expiresInSeconds, String mode) {}
```

- [ ] **Step 3: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/dto/UnlockRequest.java eu-dss-agent/src/main/java/com/linagora/eudss/agent/dto/StatusResponse.java
git commit -m "feat(agent): add UnlockRequest + StatusResponse DTOs"
```

---

## Task 3: TokenService — unlock/lock session + idle timer

**Files:**
- Create: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/service/LockedException.java`
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/service/TokenService.java`
- Test: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/service/TokenServiceSessionTest.java`

- [ ] **Step 1: Create LockedException**

```java
package com.linagora.eudss.agent.service;

/** Thrown when an operation needs an unlocked token but the session is locked. */
public class LockedException extends RuntimeException {
    public LockedException() { super("Token is locked. Call /rest/unlock first."); }
}
```

- [ ] **Step 2: Write the failing session test**

The test subclasses `TokenService` and overrides the open/close seams so no real PKCS#11 is touched.

```java
package com.linagora.eudss.agent.service;

import com.linagora.eudss.agent.config.AgentConfig;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TokenServiceSessionTest {

    private static AgentConfig cfg(int ttlSeconds, char[] pin) {
        return new AgentConfig(Path.of("/nonexistent"), 0, 0, List.of(), pin, false, ttlSeconds);
    }

    /** A TokenService with the PKCS#11 open/close stubbed out. */
    static class FakeTokenService extends TokenService {
        final AtomicInteger opens = new AtomicInteger();
        final AtomicInteger closes = new AtomicInteger();
        volatile boolean failOpen = false;
        FakeTokenService(AgentConfig c) { super(c); }
        @Override protected void doOpenAndLogin(char[] pin) {
            if (failOpen) throw new RuntimeException("PKCS11Exception: CKR_PIN_INCORRECT");
            opens.incrementAndGet();
        }
        @Override protected void doClose() { closes.incrementAndGet(); }
    }

    @Test
    void starts_locked() {
        FakeTokenService t = new FakeTokenService(cfg(300, null));
        assertThat(t.isUnlocked()).isFalse();
        assertThat(t.expiresInSeconds()).isNull();
    }

    @Test
    void unlock_then_locked_after_lock() {
        FakeTokenService t = new FakeTokenService(cfg(300, null));
        t.unlock("1234".toCharArray());
        assertThat(t.isUnlocked()).isTrue();
        assertThat(t.opens.get()).isEqualTo(1);
        assertThat(t.expiresInSeconds()).isBetween(1L, 300L);
        t.lock();
        assertThat(t.isUnlocked()).isFalse();
        assertThat(t.closes.get()).isEqualTo(1);
    }

    @Test
    void idle_timeout_relocks() throws Exception {
        FakeTokenService t = new FakeTokenService(cfg(1, null)); // 1s TTL
        t.unlock("1234".toCharArray());
        assertThat(t.isUnlocked()).isTrue();
        Thread.sleep(1300);
        assertThat(t.isUnlocked()).isFalse();
        assertThat(t.closes.get()).isEqualTo(1);
    }

    @Test
    void wrong_pin_propagates_and_stays_locked() {
        FakeTokenService t = new FakeTokenService(cfg(300, null));
        t.failOpen = true;
        assertThatThrownBy(() -> t.unlock("0000".toCharArray()))
                .hasMessageContaining("CKR_PIN_INCORRECT");
        assertThat(t.isUnlocked()).isFalse();
    }

    @Test
    void headless_unlock_never_idle_locks() throws Exception {
        FakeTokenService t = new FakeTokenService(cfg(1, "1234".toCharArray())); // headless
        t.unlock("1234".toCharArray());
        Thread.sleep(1300);
        assertThat(t.isUnlocked()).isTrue(); // no idle lock in headless mode
    }
}
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=TokenServiceSessionTest test`
Expected: FAIL — `doOpenAndLogin`/`doClose`/`unlock`/`isUnlocked`/`expiresInSeconds` not defined.

- [ ] **Step 4: Rewrite TokenService with the session machinery**

Replace the entire `TokenService.java` with:

```java
package com.linagora.eudss.agent.service;

import com.linagora.eudss.agent.config.AgentConfig;
import com.linagora.eudss.agent.dto.CertificateInfo;
import eu.europa.esig.dss.enumerations.DigestAlgorithm;
import eu.europa.esig.dss.model.Digest;
import eu.europa.esig.dss.model.SignatureValue;
import eu.europa.esig.dss.model.x509.CertificateToken;
import eu.europa.esig.dss.token.DSSPrivateKeyEntry;
import eu.europa.esig.dss.token.KSPrivateKeyEntry;
import eu.europa.esig.dss.token.Pkcs11SignatureToken;
import eu.europa.esig.dss.token.PrefilledPasswordCallback;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.security.KeyStore;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public class TokenService implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(TokenService.class);

    private final AgentConfig config;
    private volatile Pkcs11SignatureToken token;
    private volatile long expiresAtEpochMs; // 0 = locked; Long.MAX_VALUE = headless (never idle-locks)
    private final ScheduledExecutorService idleLocker =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread th = new Thread(r, "token-idle-lock");
                th.setDaemon(true);
                return th;
            });
    private ScheduledFuture<?> idleTask;

    public TokenService(AgentConfig config) {
        this.config = config;
    }

    /** Opens the PKCS#11 token and forces a login with the given PIN. Overridable for tests. */
    protected void doOpenAndLogin(char[] pin) {
        Pkcs11SignatureToken t = new Pkcs11SignatureToken(
                config.pkcs11Driver().toString(),
                new PrefilledPasswordCallback(new KeyStore.PasswordProtection(pin)),
                -1,
                config.slotListIndex(),
                null
        );
        t.getKeys(); // forces C_Login; throws on wrong/locked PIN
        this.token = t;
    }

    /** Closes the PKCS#11 token. Overridable for tests. */
    protected void doClose() {
        if (token != null) {
            try { token.close(); } catch (Exception e) { LOG.warn("Error closing PKCS#11 token", e); }
        }
    }

    public synchronized void unlock(char[] pin) {
        try {
            LOG.info("Unlocking PKCS#11 token: driver={} slotListIndex={}", config.pkcs11Driver(), config.slotListIndex());
            doOpenAndLogin(pin);
            if (config.headless()) {
                expiresAtEpochMs = Long.MAX_VALUE; // headless: stay unlocked, no idle-lock
            } else {
                scheduleIdleLock();
            }
        } finally {
            if (!config.headless()) {
                Arrays.fill(pin, '\0'); // zeroize the interactive PIN; never cached
            }
        }
    }

    private synchronized void scheduleIdleLock() {
        expiresAtEpochMs = System.currentTimeMillis() + config.pinSessionTtlSeconds() * 1000L;
        if (idleTask != null) idleTask.cancel(false);
        idleTask = idleLocker.schedule(this::lock, config.pinSessionTtlSeconds(), TimeUnit.SECONDS);
    }

    /** Marks activity: extends the idle window (no-op in headless / when locked). */
    public synchronized void touch() {
        if (isUnlocked() && !config.headless()) scheduleIdleLock();
    }

    public synchronized boolean isUnlocked() {
        return token != null && System.currentTimeMillis() < expiresAtEpochMs;
    }

    public synchronized Long expiresInSeconds() {
        if (!isUnlocked() || expiresAtEpochMs == Long.MAX_VALUE) return null;
        return Math.max(0, (expiresAtEpochMs - System.currentTimeMillis()) / 1000);
    }

    public synchronized void lock() {
        if (idleTask != null) { idleTask.cancel(false); idleTask = null; }
        doClose();
        token = null;
        expiresAtEpochMs = 0;
    }

    private Pkcs11SignatureToken requireUnlocked() {
        if (!isUnlocked()) throw new LockedException();
        return token;
    }

    public List<CertificateInfo> listCertificates() {
        List<CertificateInfo> out = requireUnlocked().getKeys().stream().map(this::toInfo).toList();
        touch();
        return out;
    }

    public byte[] signDigest(String keyId, byte[] digestBytes, DigestAlgorithm algorithm) {
        Pkcs11SignatureToken t = requireUnlocked();
        DSSPrivateKeyEntry key = t.getKeys().stream()
                .filter(k -> keyId.equals(aliasOf(k)))
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Unknown keyId: " + keyId));
        SignatureValue sv = t.signDigest(new Digest(algorithm, digestBytes), key);
        touch();
        return sv.getValue();
    }

    private CertificateInfo toInfo(DSSPrivateKeyEntry key) {
        CertificateToken cert = key.getCertificate();
        CertificateToken[] chain = key.getCertificateChain();
        Base64.Encoder b64 = Base64.getEncoder();
        return new CertificateInfo(
                aliasOf(key),
                b64.encodeToString(cert.getEncoded()),
                chain == null ? List.of() : Arrays.stream(chain).map(c -> b64.encodeToString(c.getEncoded())).toList(),
                cert.getSubject().getRFC2253(),
                cert.getIssuer().getRFC2253(),
                cert.getSerialNumber().toString(),
                cert.getNotBefore().toInstant().toString(),
                cert.getNotAfter().toInstant().toString()
        );
    }

    private static String aliasOf(DSSPrivateKeyEntry key) {
        if (key instanceof KSPrivateKeyEntry ks) return ks.getAlias();
        return key.getCertificate().getDSSIdAsString();
    }

    @Override
    public synchronized void close() {
        lock();
        idleLocker.shutdownNow();
    }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=TokenServiceSessionTest test`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/service/LockedException.java eu-dss-agent/src/main/java/com/linagora/eudss/agent/service/TokenService.java eu-dss-agent/src/test/java/com/linagora/eudss/agent/service/TokenServiceSessionTest.java
git commit -m "feat(agent): TokenService unlock/lock session with idle-TTL re-lock + PIN zeroize"
```

---

## Task 4: AgentMain — endpoints, gating, error mapping

**Files:**
- Modify: `eu-dss-agent/src/main/java/com/linagora/eudss/agent/AgentMain.java`
- Test: `eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentHttpSmokeTest.java`

- [ ] **Step 1: Update the smoke test (failing) for the new constructor + session endpoints**

Replace the `setup()` body and add tests. New `AgentHttpSmokeTest.java`:

```java
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
}
```

- [ ] **Step 2: Run the smoke test, verify it fails**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=AgentHttpSmokeTest test`
Expected: FAIL — `new AgentConfig(...)` arity, `/rest/status` 404, no `locked`/`pin_incorrect` mapping.

- [ ] **Step 3: Rewrite AgentMain**

Replace the entire `AgentMain.java` with:

```java
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
                tokenService.unlock(config.pin().clone()); // clone: unlock zeroizes the array it gets
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
        return sb.toString();
    }

    private AgentMain() {}
}
```

- [ ] **Step 4: Run the smoke test, verify it passes**

Run: `mvn -f eu-dss-agent/pom.xml -q -Dtest=AgentHttpSmokeTest test`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the whole agent module test suite**

Run: `mvn -f eu-dss-agent/pom.xml test`
Expected: BUILD SUCCESS — `AgentConfigDefaultsTest` (4), `TokenServiceSessionTest` (5), `AgentHttpSmokeTest` (6), `AgentTlsTest` (1).

- [ ] **Step 6: Commit**

```bash
git add eu-dss-agent/src/main/java/com/linagora/eudss/agent/AgentMain.java eu-dss-agent/src/test/java/com/linagora/eudss/agent/AgentHttpSmokeTest.java
git commit -m "feat(agent): /rest/unlock|lock|status endpoints, 401 locked gating, PKCS#11 error mapping, headless auto-unlock"
```

---

## Task 5: Fix FullStackE2ETest (server module) to unlock the stub

**Files:**
- Modify: `eu-dss-server/src/test/java/com/linagora/eudss/server/FullStackE2ETest.java`

- [ ] **Step 1: Locate how the test builds/stubs the agent**

Run: `grep -n "TokenService\|buildApp\|/rest/\|AgentConfig\|listCertificates\|signDigest" eu-dss-server/src/test/java/com/linagora/eudss/server/FullStackE2ETest.java`
Expected: shows where it constructs `AgentConfig`/`TokenService`/`AgentMain.buildApp` and where it calls the agent's certificates/sign.

- [ ] **Step 2: Apply the matching fixes**

- Update any `new AgentConfig(...)` to the 7-arg constructor (append `, 300` for TTL; pass `null` for the PIN arg unless the test needs headless).
- If the test uses a `TokenService` stub/subclass, override `isUnlocked()` to return `true` (and `touch()` as a no-op) OR call `POST /rest/unlock {"pin":"0000"}` once before the certificates/sign calls (mirror `AgentHttpSmokeTest.FakeToken`).
- Prefer: make the stub `isUnlocked()` return `true` so the existing flow is unchanged.

(Use `AgentHttpSmokeTest.FakeToken` from Task 4 as the reference stub shape.)

- [ ] **Step 3: Run the server module tests**

Run: `mvn -f eu-dss-server/pom.xml test`
Expected: BUILD SUCCESS (incl. `FullStackE2ETest`, `SignatureE2ETest`).

- [ ] **Step 4: Commit**

```bash
git add eu-dss-server/src/test/java/com/linagora/eudss/server/FullStackE2ETest.java
git commit -m "test(server): unlock the stubbed agent in FullStackE2ETest (PIN-at-signing API)"
```

---

## Task 6: UI agentApi — typed errors + unlock/lock/status

**Files:**
- Modify: `eu-dss-ui/src/services/agentApi.ts`

- [ ] **Step 1: Replace agentApi.ts**

```typescript
const AGENT_BASE = 'https://localhost:9795/rest';

export interface AgentCertificate {
  keyId: string;
  certificateBase64: string;
  certificateChainBase64: string[];
  subjectDn: string;
  issuerDn: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

export interface AgentSessionStatus {
  unlocked: boolean;
  expiresInSeconds: number | null;
  mode: 'interactive' | 'headless';
}

/** Carries the agent's structured error code so the UI can react (locked → prompt PIN). */
export class AgentError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

async function parseError(res: Response, path: string): Promise<AgentError> {
  let code = 'http_' + res.status;
  let message = `Agent ${path} → HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') code = body.error;
    if (body && typeof body.message === 'string') message = body.message;
  } catch {
    /* non-JSON body */
  }
  return new AgentError(res.status, code, message);
}

async function agentGet<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, { credentials: 'omit' });
  if (!res.ok) throw await parseError(res, path);
  return res.json() as Promise<T>;
}

async function agentPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res, path);
  return res.json() as Promise<T>;
}

export const agentApi = {
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${AGENT_BASE}/health`, { credentials: 'omit' });
      return res.ok;
    } catch {
      return false;
    }
  },

  getStatus: () => agentGet<AgentSessionStatus>('/status'),

  unlock: (pin: string) => agentPost<AgentSessionStatus>('/unlock', { pin }),

  lock: () => agentPost<{ status: string }>('/lock', {}),

  listCertificates: () => agentGet<{ certificates: AgentCertificate[] }>('/certificates'),

  signDigest: (keyId: string, digestBase64: string, digestAlgorithm: 'SHA256' | 'SHA384' | 'SHA512') =>
    agentPost<{ signatureValueBase64: string }>('/sign', { keyId, digestBase64, digestAlgorithm }),
};
```

- [ ] **Step 2: Typecheck/build**

Run: `cd eu-dss-ui && npm run build`
Expected: build succeeds (TypeScript happy). `cd ..` after.

- [ ] **Step 3: Commit**

```bash
git add eu-dss-ui/src/services/agentApi.ts
git commit -m "feat(ui): agentApi unlock/lock/getStatus + typed AgentError(code)"
```

---

## Task 7: UI PinModal component

**Files:**
- Create: `eu-dss-ui/src/components/PinModal.tsx`

- [ ] **Step 1: Create PinModal.tsx**

```tsx
import { useState } from 'react';

interface PinModalProps {
  open: boolean;
  busy: boolean;
  errorMessage?: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}

export function PinModal({ open, busy, errorMessage, onSubmit, onCancel }: PinModalProps) {
  const [pin, setPin] = useState('');
  if (!open) return null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pin.length === 0 || busy) return;
    onSubmit(pin);
    setPin('');
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Saisie du PIN">
      <div className="modal-card">
        <h3>Déverrouiller la clé de signature</h3>
        <p className="muted">Saisissez le PIN de votre carte pour signer.</p>
        <form onSubmit={submit}>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            style={{ width: '100%', fontSize: 18, letterSpacing: 4 }}
          />
          {errorMessage && <div className="status error" style={{ marginTop: 8 }}>{errorMessage}</div>}
          <div className="status warn" style={{ marginTop: 8 }}>
            ⚠ Attention : un PIN erroné plusieurs fois (≈3) <strong>bloque la carte</strong>.
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onCancel} disabled={busy}>Annuler</button>
            <button type="submit" className="primary" disabled={busy || pin.length === 0}>
              {busy ? 'Déverrouillage…' : 'Déverrouiller'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal modal CSS**

Append to `eu-dss-ui/src/styles.css`:

```css
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal-card {
  background: #fff; border-radius: 8px; padding: 20px; width: 360px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
}
```

- [ ] **Step 3: Build**

Run: `cd eu-dss-ui && npm run build` (then `cd ..`)
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add eu-dss-ui/src/components/PinModal.tsx eu-dss-ui/src/styles.css
git commit -m "feat(ui): PinModal component (masked PIN entry + card-lock warning)"
```

---

## Task 8: SignWorkspace — status, lock indicator, unlock-before-sign

**Files:**
- Modify: `eu-dss-ui/src/components/SignWorkspace.tsx`

- [ ] **Step 1: Add imports + session state**

At the top imports, add `PinModal` and `AgentError`, `AgentSessionStatus`:

```tsx
import { useEffect, useState } from 'react';
import { agentApi, AgentCertificate, AgentError, AgentSessionStatus } from '../services/agentApi';
import { backendApi, SignatureParams } from '../services/backendApi';
import { downloadBase64, downloadZip, fileToBase64 } from '../services/fileUtils';
import { PinModal } from './PinModal';
```

Inside `SignWorkspace`, after the existing `useState` calls (after `busy`), add:

```tsx
  const [status, setStatus] = useState<AgentSessionStatus | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>();
  // resolver for the unlock promise the signing flow awaits
  const [pinResolver, setPinResolver] = useState<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
```

- [ ] **Step 2: Replace checkAgent to load status (and not hard-fail when locked)**

Replace the `checkAgent` function (lines ~34-47) with:

```tsx
  async function checkAgent() {
    setAgentStatus('checking');
    const ok = await agentApi.isAvailable();
    if (!ok) { setAgentStatus('unavailable'); return; }
    setAgentStatus('available');
    try {
      const st = await agentApi.getStatus();
      setStatus(st);
      if (st.unlocked) await loadCertificates();
    } catch {
      setStatus(null);
    }
  }

  async function loadCertificates() {
    const { certificates } = await agentApi.listCertificates();
    setCertificates(certificates);
    if (certificates[0]) setSelectedKeyId(certificates[0].keyId);
  }
```

- [ ] **Step 3: Add unlock/lock helpers + the PIN-prompt gate**

Add these functions inside the component (after `loadCertificates`):

```tsx
  // Shows the modal and resolves once the token is unlocked (or rejects on cancel).
  function promptUnlock(): Promise<void> {
    setPinError(undefined);
    setPinOpen(true);
    return new Promise<void>((resolve, reject) => setPinResolver({ resolve, reject }));
  }

  async function submitPin(pin: string) {
    setPinBusy(true);
    setPinError(undefined);
    try {
      const st = await agentApi.unlock(pin);
      setStatus(st);
      await loadCertificates();
      setPinOpen(false);
      pinResolver?.resolve();
      setPinResolver(null);
    } catch (e) {
      const ae = e as AgentError;
      setPinError(ae.code === 'pin_locked'
        ? 'Carte bloquée (trop d’essais). Déblocage par PUK nécessaire.'
        : ae.code === 'pin_incorrect' ? 'PIN incorrect.' : (ae.message || 'Échec du déverrouillage.'));
    } finally {
      setPinBusy(false);
    }
  }

  function cancelPin() {
    setPinOpen(false);
    pinResolver?.reject(new Error('PIN annulé'));
    setPinResolver(null);
  }

  // Ensures unlocked before a signing operation; prompts if needed.
  async function ensureUnlocked() {
    const st = await agentApi.getStatus().catch(() => null);
    setStatus(st);
    if (!st?.unlocked) await promptUnlock();
  }

  async function lockNow() {
    try { await agentApi.lock(); } catch { /* ignore */ }
    setStatus(await agentApi.getStatus().catch(() => null));
  }
```

- [ ] **Step 4: Make signOne retry once on a mid-batch 401 `locked`**

Replace the `catch (e)` block of `signOne` (around line 102-104) with a locked-aware retry:

```tsx
    } catch (e) {
      if (e instanceof AgentError && e.code === 'locked') {
        try {
          await promptUnlock();      // idle-locked mid-batch → re-prompt
          await signOne(doc, cert);  // retry this doc once
          return;
        } catch (cancel) {
          patch(doc.id, { status: 'error', error: 'Signature annulée (PIN requis)' });
          return;
        }
      }
      patch(doc.id, { status: 'error', error: (e as Error).message });
    }
```

- [ ] **Step 5: Gate signAll / signSingle on ensureUnlocked**

Replace `signAll` and `signSingle` (lines ~107-123) with:

```tsx
  async function signAll() {
    const cert = certificates.find((c) => c.keyId === selectedKeyId);
    if (!cert) return;
    try { await ensureUnlocked(); } catch { return; }
    setBusy(true);
    for (const doc of docs) {
      if (doc.status !== 'signed') await signOne(doc, cert);
    }
    setBusy(false);
  }

  async function signSingle(doc: SignDoc) {
    const cert = certificates.find((c) => c.keyId === selectedKeyId);
    if (!cert) return;
    try { await ensureUnlocked(); } catch { return; }
    setBusy(true);
    await signOne(doc, cert);
    setBusy(false);
  }
```

Note: when locked, `certificates` may be empty → `selectedKeyId` empty. After the first `ensureUnlocked()` → `submitPin` → `loadCertificates()` populates them. So on the very first sign while locked, call `ensureUnlocked()` BEFORE the `certificates.find`. Adjust both functions to unlock first:

```tsx
  async function signAll() {
    try { await ensureUnlocked(); } catch { return; }
    const cert = certificates.find((c) => c.keyId === selectedKeyId) ?? certificates[0];
    if (!cert) return;
    setBusy(true);
    for (const doc of docs) {
      if (doc.status !== 'signed') await signOne(doc, cert);
    }
    setBusy(false);
  }

  async function signSingle(doc: SignDoc) {
    try { await ensureUnlocked(); } catch { return; }
    const cert = certificates.find((c) => c.keyId === selectedKeyId) ?? certificates[0];
    if (!cert) return;
    setBusy(true);
    await signOne(doc, cert);
    setBusy(false);
  }
```

(Use this second version — it unlocks before reading `certificates`.)

- [ ] **Step 6: Render the lock indicator + the PinModal**

In the "Agent local" card, replace the `agentStatus === 'available' && certificates.length > 0` block's `<div className="status ok">…</div>` line with a lock-aware indicator:

```tsx
            <div className="status ok">
              Agent connecté{certificates.length > 0 ? `, ${certificates.length} certificat(s)` : ''}.{' '}
              {status?.unlocked
                ? <>🔓 déverrouillé{status.expiresInSeconds != null ? ` (${status.expiresInSeconds}s)` : ''} <button onClick={() => void lockNow()}>Verrouiller</button></>
                : <>🔒 verrouillé <button onClick={() => void ensureUnlocked()}>Déverrouiller</button></>}
            </div>
```

And just before the closing `</div>` of the outermost returned element (end of the component's JSX, before `);`), add:

```tsx
      <PinModal
        open={pinOpen}
        busy={pinBusy}
        errorMessage={pinError}
        onSubmit={(pin) => void submitPin(pin)}
        onCancel={cancelPin}
      />
```

Also: the `agentStatus === 'available' && certificates.length === 0` "aucun certificat" warning should only show when unlocked (when locked, no certs is expected). Change its condition to:
`agentStatus === 'available' && status?.unlocked && certificates.length === 0`.

And `canSign` no longer requires a selected key up front (we unlock first). Change to:
`const canSign = agentStatus === 'available' && pendingCount > 0 && !busy;`

- [ ] **Step 7: Build**

Run: `cd eu-dss-ui && npm run build` (then `cd ..`)
Expected: build succeeds, no TS errors.

- [ ] **Step 8: Commit**

```bash
git add eu-dss-ui/src/components/SignWorkspace.tsx
git commit -m "feat(ui): PIN-at-signing flow — status, lock indicator, unlock-before-sign, mid-batch re-prompt"
```

---

## Task 9: Full build + manual smoke

**Files:** none (verification)

- [ ] **Step 1: Full agent + server test suites**

Run: `mvn -f eu-dss-agent/pom.xml test && mvn -f eu-dss-server/pom.xml test`
Expected: BUILD SUCCESS for both.

- [ ] **Step 2: UI build**

Run: `cd eu-dss-ui && npm run build` (then `cd ..`)
Expected: success.

- [ ] **Step 3: Manual smoke (local, no real token needed for the lock UX)**

- Start agent without `EUDSS_AGENT_PIN` (interactive): `EUDSS_AGENT_TLS=false mvn -f eu-dss-agent/pom.xml exec:java` (or run the built jar). Confirm `curl -s localhost:9795/rest/status` → `"unlocked":false`.
- `curl -s localhost:9795/rest/certificates` → HTTP 401 `locked`.
- `curl -s -X POST localhost:9795/rest/lock` → `{"status":"locked"}`.
- (Real-token unlock/sign: manual E2E on macOS + Windows ARM64 as previously validated.)

- [ ] **Step 4: Update memory note (optional)**

The roadmap memory's "Open UX item (PIN at signing time)" is now implemented — note it as done in `project_signing_roadmap.md` after merge.

---

## Self-Review (completed by plan author)

- **Spec coverage:** decisions 1–5 → Tasks 1 (config/mode/TTL), 3 (session/idle/zeroize), 4 (endpoints/gating/error-map/headless), 6–8 (UI collect/modal/indicator). API table → Task 4. Error mapping → Task 4 `mapTokenError`. Tests → Tasks 1,3,4,5; UI build → 6,7,8. Acceptance #1–8 → covered by AgentHttpSmokeTest + manual smoke (Task 9). ✓
- **Placeholder scan:** none — every code step has complete code; Task 5 is intentionally adaptive (it depends on the current FullStackE2ETest shape) but gives the exact rule + reference stub. ✓
- **Type consistency:** `unlock/lock/isUnlocked/expiresInSeconds/touch` consistent across TokenService (Task 3), the smoke-test stub + endpoints (Task 4); `AgentError.code` values (`locked`, `pin_incorrect`, `pin_locked`) consistent between AgentMain (Task 4) and the UI (Tasks 6, 8); `AgentSessionStatus`/`StatusResponse` fields (`unlocked`, `expiresInSeconds`, `mode`) consistent agent↔UI. ✓
