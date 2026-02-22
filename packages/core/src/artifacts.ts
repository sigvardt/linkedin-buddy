import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConfigPaths } from "./config.js";
import type { AssistantDatabase } from "./db/database.js";

function assertWithinRunDir(runDir: string, targetPath: string): void {
  if (targetPath === runDir) {
    return;
  }

  if (!targetPath.startsWith(`${runDir}${path.sep}`)) {
    throw new Error(`Artifact path escapes run directory: ${targetPath}`);
  }
}

export class ArtifactHelpers {
  private readonly runDir: string;

  constructor(
    private readonly paths: ConfigPaths,
    private readonly runId: string,
    private readonly db?: AssistantDatabase
  ) {
    this.runDir = path.join(this.paths.artifactsDir, this.runId);
    mkdirSync(this.runDir, { recursive: true });
  }

  getRunDir(): string {
    return this.runDir;
  }

  resolve(relativePath: string): string {
    const targetPath = path.resolve(this.runDir, relativePath);
    assertWithinRunDir(this.runDir, targetPath);
    return targetPath;
  }

  writeText(
    relativePath: string,
    contents: string,
    artifactType: string = "text/plain",
    metadata: Record<string, unknown> = {}
  ): string {
    const artifactPath = this.resolve(relativePath);
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, contents, "utf8");
    this.indexArtifact(relativePath, artifactType, metadata);
    return artifactPath;
  }

  writeJson(
    relativePath: string,
    value: unknown,
    metadata: Record<string, unknown> = {}
  ): string {
    return this.writeText(
      relativePath,
      `${JSON.stringify(value, null, 2)}\n`,
      "application/json",
      metadata
    );
  }

  registerArtifact(
    relativePath: string,
    artifactType: string,
    metadata: Record<string, unknown> = {}
  ): string {
    const artifactPath = this.resolve(relativePath);
    this.indexArtifact(relativePath, artifactType, metadata);
    return artifactPath;
  }

  private indexArtifact(
    relativePath: string,
    artifactType: string,
    metadata: Record<string, unknown>
  ): void {
    if (!this.db) {
      return;
    }

    this.db.insertArtifactIndex({
      runId: this.runId,
      artifactPath: relativePath,
      artifactType,
      metadataJson: JSON.stringify(metadata),
      createdAtMs: Date.now()
    });
  }
}
