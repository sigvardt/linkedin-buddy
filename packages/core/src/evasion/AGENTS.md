# packages/core/src/evasion — Anti-Bot Evasion System

## Overview

Behavioral simulation to avoid LinkedIn bot detection. Four levels with increasing sophistication.

## Files

| File | Purpose |
|------|---------|
| `browser.ts` | Browser-level: fingerprint hardening, captcha detection, honeypot detection, viewport jitter, momentum scroll, tab blur simulation |
| `session.ts` | Page-level: `EvasionSession` class wrapping behavioral helpers (mouse movement, scrolling, delays) |
| `math.ts` | Math primitives: Bezier path computation, Poisson interval sampling, reading pause calculation, momentum step generation |
| `profiles.ts` | Profile definitions (minimal, moderate, paranoid) with feature matrices and level resolution |
| `types.ts` | Type definitions: `EvasionLevel`, `EvasionProfile`, session options, diagnostics |
| `shared.ts` | Shared utilities across evasion modules |

## Evasion Levels

| Level | Mouse | Typing | Fingerprint | Delays | Use Case |
|-------|-------|--------|-------------|--------|----------|
| `off` | No | No | No | No | Testing only |
| `light` | Basic | No | No | Basic | Low-risk reads |
| `moderate` | Bezier | Yes | Yes | Poisson | Default — balanced |
| `aggressive` | Bezier + blur | Full | Full + CDP | Poisson + request | High-risk writes |

## Configuration Precedence

1. Runtime option (`evasionLevel` parameter)
2. Environment variable (`LINKEDIN_BUDDY_EVASION_LEVEL`)
3. Default: `moderate`

Diagnostics: set `LINKEDIN_BUDDY_EVASION_DIAGNOSTICS=true` for verbose logging.

## Math Patterns

- **Bezier curves** (`math.ts`): Realistic mouse paths with control point randomization
- **Poisson sampling** (`math.ts`): Natural-feeling intervals between actions
- **Reading pause** (`math.ts`): Simulates reading time based on content length
- **Momentum scroll** (`browser.ts`): Scroll with acceleration/deceleration

## Anti-Patterns

- NEVER use `off` level in production — only for local testing
- NEVER make evasion patterns too uniform — randomization is critical for avoiding detection
- NEVER skip evasion for credential entry — use `humanize.ts` typing profiles for sensitive fields
- Changes to math distributions require careful validation — small changes can make patterns detectable
