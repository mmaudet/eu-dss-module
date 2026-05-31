package com.linagora.eudss.server.config;

import com.fasterxml.jackson.core.StreamReadConstraints;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Raises Jackson's per-string read limit so large documents can be carried as
 * base64 inside the JSON request bodies of {@code /api/sign/*} and {@code /api/validate}.
 *
 * <p>Jackson 2.15+ caps a single JSON string value at 20 MB
 * ({@link StreamReadConstraints#DEFAULT_MAX_STRING_LEN}). A document's base64 inflates
 * its size by ~4/3, so an ~18 MB PDF (~25 M chars) or a ~33 MB pptx (~45 M chars) trips
 * the cap with "String value length ... exceeds the maximum allowed (20000000)".
 *
 * <p>This raises the cap to {@value #MAX_JSON_STRING_LEN} chars (~150 MB binary after
 * base64). It is an MVP trade-off: base64-in-JSON holds the whole document in memory.
 * A future multipart/form-data upload would stream the binary and remove the inflation.
 */
@Configuration
public class JacksonConfig {

    /** ~200 M base64 chars ≈ 150 MB binary document. */
    static final int MAX_JSON_STRING_LEN = 200_000_000;

    @Bean
    Jackson2ObjectMapperBuilderCustomizer largeStringJacksonCustomizer() {
        return builder -> builder.postConfigurer(mapper ->
                mapper.getFactory().setStreamReadConstraints(
                        StreamReadConstraints.builder()
                                .maxStringLength(MAX_JSON_STRING_LEN)
                                .build()));
    }
}
