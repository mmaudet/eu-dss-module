package com.linagora.eudss.server;

import com.linagora.eudss.server.config.EudssProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(EudssProperties.class)
public class EuDssServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(EuDssServerApplication.class, args);
    }
}
