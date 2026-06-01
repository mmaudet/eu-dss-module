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
