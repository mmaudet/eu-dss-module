package com.linagora.eudss.agent.config;

import java.io.Console;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

public record AgentConfig(
        Path pkcs11Driver,
        int slotListIndex,
        int port,
        List<String> corsHosts,
        char[] pin,
        boolean tlsEnabled
) {
    private static final String DEFAULT_DRIVER_MAC = "/Library/SCMiddleware/libidop11.dylib";
    private static final String DEFAULT_DRIVER_LINUX = "/usr/lib/libidop11.so";
    private static final String DEFAULT_DRIVER_WIN = "C:\\Windows\\System32\\idop11.dll";

    public static AgentConfig load() {
        return fromEnv(System.getenv(), System.getProperty("os.name", ""), loadPin());
    }

    /** Pure config resolution from explicit inputs — package-private so it can be unit-tested
     *  without manipulating environment variables or requiring a console for the PIN. */
    static AgentConfig fromEnv(Map<String, String> env, String osName, char[] pin) {
        String driver = env.getOrDefault("EUDSS_PKCS11_DRIVER", defaultDriver(osName));
        int slot = Integer.parseInt(env.getOrDefault("EUDSS_PKCS11_SLOT", "0"));
        int port = Integer.parseInt(env.getOrDefault("EUDSS_AGENT_PORT", "9795"));
        String origins = env.getOrDefault("EUDSS_CORS_HOSTS",
                "http://localhost:5173,http://localhost:8080,http://localhost:4173");
        boolean tls = !"false".equalsIgnoreCase(env.getOrDefault("EUDSS_AGENT_TLS", "true"));
        return new AgentConfig(
                Path.of(driver),
                slot,
                port,
                Arrays.stream(origins.split(",")).map(String::trim).filter(s -> !s.isBlank()).toList(),
                pin,
                tls
        );
    }

    static String defaultDriver(String osName) {
        String os = osName.toLowerCase();
        if (os.contains("mac")) return DEFAULT_DRIVER_MAC;
        if (os.contains("win")) return DEFAULT_DRIVER_WIN;
        return DEFAULT_DRIVER_LINUX;
    }

    private static char[] loadPin() {
        String envPin = System.getenv("EUDSS_AGENT_PIN");
        if (envPin != null && !envPin.isBlank()) {
            return envPin.toCharArray();
        }
        Console console = System.console();
        if (console != null) {
            return console.readPassword("PIN signature : ");
        }
        throw new IllegalStateException(
                "No PIN provided. Set EUDSS_AGENT_PIN env var or run the agent in an interactive terminal.");
    }
}
