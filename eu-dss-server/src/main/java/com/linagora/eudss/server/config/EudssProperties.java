package com.linagora.eudss.server.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

@ConfigurationProperties(prefix = "eudss")
public record EudssProperties(Tsa tsa, Cors cors) {

    public record Tsa(String url) {}

    public record Cors(List<String> allowedOrigins) {}
}
