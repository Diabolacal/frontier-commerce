/**
 * SUI_RPC_URL -> gRPC host/credentials parsing.
 *
 * The incident this guards against (2026-07-28): the Sui testnet/devnet
 * fullnodes stopped serving gRPC-web as part of the JSON-RPC shutdown, so
 * SuiGrpcClient's default GrpcWebFetchTransport got `application/json` back on
 * every call and the sponsor went hard down. Moving to native gRPC means the
 * endpoint config is no longer a URL handed to fetch but a `host:port` handed
 * to @grpc/grpc-js — so the same SUI_RPC_URL values operators already have
 * deployed must keep working, and a malformed one must never silently
 * downgrade a public fullnode link to plaintext.
 */
import { describe, expect, it } from 'vitest';
import { grpcHostFromUrl, isPlaintextGrpcUrl } from './server.js';

describe('grpcHostFromUrl', () => {
  it('accepts the deployed https URL with an explicit port', () => {
    expect(grpcHostFromUrl('https://fullnode.testnet.sui.io:443')).toBe('fullnode.testnet.sui.io:443');
  });

  it('defaults to 443 when an https URL omits the port', () => {
    expect(grpcHostFromUrl('https://fullnode.testnet.sui.io')).toBe('fullnode.testnet.sui.io:443');
  });

  it('defaults to 80 for an explicitly plaintext endpoint', () => {
    expect(grpcHostFromUrl('http://sui-node.internal')).toBe('sui-node.internal:80');
    expect(grpcHostFromUrl('http://127.0.0.1:9000')).toBe('127.0.0.1:9000');
  });

  it('passes a bare host:port straight through', () => {
    expect(grpcHostFromUrl('fullnode.testnet.sui.io:443')).toBe('fullnode.testnet.sui.io:443');
  });

  it('adds the TLS port to a bare hostname', () => {
    expect(grpcHostFromUrl('fullnode.testnet.sui.io')).toBe('fullnode.testnet.sui.io:443');
  });

  it('ignores surrounding whitespace from a sloppy env var', () => {
    expect(grpcHostFromUrl('  https://fullnode.testnet.sui.io:443  ')).toBe('fullnode.testnet.sui.io:443');
  });

  it('drops any path, query or credentials rather than passing them to grpc-js', () => {
    expect(grpcHostFromUrl('https://fullnode.testnet.sui.io:443/v2?x=1')).toBe('fullnode.testnet.sui.io:443');
  });
});

describe('isPlaintextGrpcUrl', () => {
  it('treats http:// and grpc:// as plaintext', () => {
    expect(isPlaintextGrpcUrl('http://127.0.0.1:9000')).toBe(true);
    expect(isPlaintextGrpcUrl('grpc://sui-node.internal:9000')).toBe(true);
  });

  it('treats https:// as TLS', () => {
    expect(isPlaintextGrpcUrl('https://fullnode.testnet.sui.io:443')).toBe(false);
  });

  it('fails safe: an unschemed host is TLS, never plaintext', () => {
    // A bare host must not silently become an unencrypted link to a public
    // fullnode — worst case it refuses to connect, which is visible.
    expect(isPlaintextGrpcUrl('fullnode.testnet.sui.io:443')).toBe(false);
  });
});
