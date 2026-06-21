package com.linagora.eudss.server.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class CorsConfig implements WebMvcConfigurer {

    private final EudssProperties props;

    public CorsConfig(EudssProperties props) {
        this.props = props;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                // allowedOriginPatterns (not allowedOrigins) so Tauri webview origins
                // (tauri://localhost, http(s)://tauri.localhost) are accepted — the app
                // talks to its local sidecar backend, not a browser same-origin.
                .allowedOriginPatterns(props.cors().allowedOrigins().toArray(String[]::new))
                .allowedMethods("GET", "POST", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);
    }
}
