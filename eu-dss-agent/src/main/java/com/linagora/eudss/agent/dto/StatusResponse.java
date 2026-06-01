package com.linagora.eudss.agent.dto;

public record StatusResponse(boolean unlocked, Long expiresInSeconds, String mode) {}
