package com.linagora.eudss.agent.service;

/** Thrown when an operation needs an unlocked token but the session is locked. */
public class LockedException extends RuntimeException {
    public LockedException() { super("Token is locked. Call /rest/unlock first."); }
}
