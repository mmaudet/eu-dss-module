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
    private static final String DEFAULT_DRIVER_LINUX = "/usr/lib/SCMiddleware/libidop11.so";
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
        int ttl = Math.max(1, Integer.parseInt(env.getOrDefault("EUDSS_PIN_SESSION_TTL", "300")));
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
