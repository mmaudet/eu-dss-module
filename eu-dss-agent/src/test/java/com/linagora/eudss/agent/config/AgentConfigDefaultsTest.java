package com.linagora.eudss.agent.config;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Locks in the agent config defaults (notably slotListIndex=0 -> the qualified signing slot on the
 * IDEMIA card, see project memory) without needing real env vars or a console PIN.
 */
class AgentConfigDefaultsTest {

    private static final char[] PIN = "0000".toCharArray();

    @Test
    void defaults_to_slot_0_and_macos_driver() {
        AgentConfig cfg = AgentConfig.fromEnv(Map.of(), "Mac OS X", PIN);
        assertThat(cfg.slotListIndex()).isEqualTo(0);
        assertThat(cfg.pkcs11Driver().toString()).isEqualTo("/Library/SCMiddleware/libidop11.dylib");
        assertThat(cfg.port()).isEqualTo(9795);
        assertThat(cfg.corsHosts()).contains("http://localhost:5173");
    }

    @Test
    void env_overrides_slot_and_driver() {
        AgentConfig cfg = AgentConfig.fromEnv(
                Map.of("EUDSS_PKCS11_SLOT", "1", "EUDSS_PKCS11_DRIVER", "/custom/lib.so", "EUDSS_AGENT_PORT", "9999"),
                "Mac OS X", PIN);
        assertThat(cfg.slotListIndex()).isEqualTo(1);
        assertThat(cfg.pkcs11Driver().toString()).isEqualTo("/custom/lib.so");
        assertThat(cfg.port()).isEqualTo(9999);
    }

    @Test
    void default_driver_is_os_specific() {
        assertThat(AgentConfig.defaultDriver("Linux")).isEqualTo("/usr/lib/libidop11.so");
        assertThat(AgentConfig.defaultDriver("Windows 11")).isEqualTo("C:\\Program Files\\Smart Card Middleware\\bin\\idoPKCS.dll");
        assertThat(AgentConfig.defaultDriver("Mac OS X")).isEqualTo("/Library/SCMiddleware/libidop11.dylib");
    }
}
