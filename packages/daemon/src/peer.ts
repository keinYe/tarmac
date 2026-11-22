import type net from 'node:net';
import { LIMITS } from '../../protocol/src/index.ts';

// Per-session subscription state on one connection. A connection can control
// several sessions at once, but each PTY has at most one controlling peer.
export interface PeerSub {
  attached: boolean;
  lastSent: number;
  lastAck: number;
  pending: { seq: number; bytes: number }[];
  bytes: number;
  // Input is accepted once the replay has been acknowledged up to target.
  target: number;
  ready: boolean;
  // A replay base split into parts; output records wait until every part is acknowledged.
  snapshot?: { data: string; total: number; sent: number; acked: number };
}

export interface Peer {
  socket: net.Socket;
  subs: Map<string, PeerSub>;
  desktop: boolean;
  // False until a valid auth request where the daemon requires a token.
  authenticated: boolean;
  // The App instance a desktop connection belongs to; its reconnects are not another window.
  appId?: string;
}

export function createPeer(socket: net.Socket, authenticated = true): Peer {
  return { socket, subs: new Map(), desktop: false, authenticated };
}

export function subFor(peer: Peer, sessionId: string): PeerSub {
  let sub = peer.subs.get(sessionId);
  if (!sub) {
    sub = { attached: false, lastSent: 0, lastAck: -1, pending: [], bytes: 0, target: 0, ready: false };
    peer.subs.set(sessionId, sub);
  }
  return sub;
}

export function detachPeer(peer: Peer, sessionId: string): void {
  peer.subs.delete(sessionId);
}

// Mirrors the M0 transport guard: a stuck reader is dropped, not buffered forever.
export function peerWritable(peer: Peer): boolean {
  return !peer.socket.destroyed && peer.socket.writableLength <= LIMITS.frameBytes;
}
