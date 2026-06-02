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
        assertThat(AgentConfig.defaultDriver("Linux")).isEqualTo("/usr/lib/SCMiddleware/libidop11.so");
        assertThat(AgentConfig.defaultDriver("Windows 11")).isEqualTo("C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll");
        assertThat(AgentConfig.defaultDriver("Mac OS X")).isEqualTo("/Library/SCMiddleware/libidop11.dylib");
    }
}
