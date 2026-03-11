#!/usr/bin/env node

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandRoot = path.join(projectRoot, "assets", "brand");
const pngRoot = path.join(brandRoot, "png");

const rasterJobs = [
  { source: "favicon.svg", output: path.join(pngRoot, "logo-mark-16.png"), size: 16 },
  { source: "favicon.svg", output: path.join(pngRoot, "logo-mark-32.png"), size: 32 },
  { source: "logo-mark.svg", output: path.join(pngRoot, "logo-mark-64.png"), size: 64 },
  { source: "logo-mark.svg", output: path.join(pngRoot, "logo-mark-128.png"), size: 128 },
  { source: "logo-mark.svg", output: path.join(pngRoot, "logo-mark-256.png"), size: 256 },
  { source: "logo-mark.svg", output: path.join(pngRoot, "logo-mark-512.png"), size: 512 },
  { source: "favicon.svg", output: path.join(brandRoot, "favicon-32.png"), size: 32 },
  { source: "social-preview.svg", output: path.join(brandRoot, "social-preview.png"), width: 1280, height: 640 }
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(details.length > 0 ? details : `Command failed: ${command} ${args.join(" ")}`);
  }
}

function ensureDirectories() {
  if (!existsSync(brandRoot)) {
    throw new Error(`Missing brand assets directory: ${brandRoot}`);
  }

  if (!existsSync(pngRoot)) {
    mkdirSync(pngRoot, { recursive: true });
  }
}

function renderSquareSvg(inputPath, outputPath, size) {
  run("sips", [
    "-z",
    String(size),
    String(size),
    "-s",
    "format",
    "png",
    inputPath,
    "--out",
    outputPath
  ]);
}

function renderRectSvg(inputPath, outputPath, width, height) {
  run("sips", [
    "-z",
    String(height),
    String(width),
    "-s",
    "format",
    "png",
    inputPath,
    "--out",
    outputPath
  ]);
}

function main() {
  ensureDirectories();

  for (const job of rasterJobs) {
    const inputPath = path.join(brandRoot, job.source);
    if (!existsSync(inputPath)) {
      throw new Error(`Missing input asset: ${inputPath}`);
    }

    if ("size" in job) {
      renderSquareSvg(inputPath, job.output, job.size);
      continue;
    }

    renderRectSvg(inputPath, job.output, job.width, job.height);
  }

  process.stdout.write("Brand assets generated.\n");
}

main();
