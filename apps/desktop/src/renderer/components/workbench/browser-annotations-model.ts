import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Annotation } from "@coflux/protocol";
import type { AnnotationChange, AnnotationMutateResult, CofluxClient } from "@coflux/client";

/**
 * Browser annotations of each workspace as this renderer last loaded them (plan
 * 20260929-browser-annotations). One model per client, shared by every browser tab of a workspace.
 * The content comes from the workspace device's worker over the Device channel and lives only in
 * memory here — which is also the read-only list shown while the device is offline.
 *
 * A workspace is refetched when the revision the center relays differs from the one loaded, when a
 * change was saved, and the first time a tab shows the workspace.
 */

export type WorkspaceAnnotationsStatus = "ok" | "unsupported" | "unreachable" | "error";

export type WorkspaceAnnotations = {
  /** null until the first successful load. */
  annotations: Annotation[] | null;
  revision: number | null;
  loading: boolean;
  status: WorkspaceAnnotationsStatus;
  error: string;
};

export type AnnotationsModel = {
  store: StoreApi<{ workspaces: Readonly<Record<string, WorkspaceAnnotations>> }>;
  refresh: (workspaceId: string) => Promise<void>;
  change: (workspaceId: string, change: AnnotationChange) => Promise<AnnotationMutateResult>;
  /** An object URL for one stored image, cached; null when it cannot be read. */
  imageUrl: (workspaceId: string, annotationId: string, imageId: string) => Promise<string | null>;
};

const EMPTY: WorkspaceAnnotations = { annotations: null, revision: null, loading: false, status: "ok", error: "" };

const models = new WeakMap<CofluxClient, AnnotationsModel>();

export function annotationsModelFor(client: CofluxClient): AnnotationsModel {
  const existing = models.get(client);
  if (existing) return existing;
  const store = createStore<{ workspaces: Readonly<Record<string, WorkspaceAnnotations>> }>(() => ({ workspaces: {} }));
  const inflight = new Map<string, Promise<void>>();
  const images = new Map<string, Promise<string | null>>();

  function patch(workspaceId: string, next: Partial<WorkspaceAnnotations>) {
    store.setState((state) => ({ workspaces: { ...state.workspaces, [workspaceId]: { ...(state.workspaces[workspaceId] ?? EMPTY), ...next } } }));
  }

  function refresh(workspaceId: string): Promise<void> {
    const running = inflight.get(workspaceId);
    if (running) return running;
    patch(workspaceId, { loading: true });
    const promise = client.listAnnotations(workspaceId).then((result) => {
      if (result.ok) {
        patch(workspaceId, { annotations: result.annotations, revision: result.revision, loading: false, status: "ok", error: "" });
      } else {
        // The list already loaded stays: it is what the offline panel shows, read-only.
        patch(workspaceId, { loading: false, status: result.reason === "refused" ? "error" : result.reason, error: result.error });
      }
    });
    const settled = promise.finally(() => inflight.delete(workspaceId));
    inflight.set(workspaceId, settled);
    return settled;
  }

  async function change(workspaceId: string, next: AnnotationChange): Promise<AnnotationMutateResult> {
    const result = await client.changeAnnotations(workspaceId, next);
    if (result.ok) {
      await (inflight.get(workspaceId) ?? Promise.resolve());
      void refresh(workspaceId);
    } else if (result.reason !== "refused") {
      patch(workspaceId, { status: result.reason, error: result.error });
    }
    return result;
  }

  function imageUrl(workspaceId: string, annotationId: string, imageId: string): Promise<string | null> {
    const key = `${workspaceId}/${annotationId}/${imageId}`;
    const cached = images.get(key);
    if (cached) return cached;
    const promise = client.readAnnotationImage(workspaceId, annotationId, imageId).then((result) => {
      if (!result.ok) {
        images.delete(key);
        return null;
      }
      const bytes = new Uint8Array(result.data);
      return URL.createObjectURL(new Blob([bytes], { type: result.mimeType || "image/png" }));
    });
    images.set(key, promise);
    return promise;
  }

  const model: AnnotationsModel = { store, refresh, change, imageUrl };
  models.set(client, model);
  return model;
}

/**
 * A workspace's annotations for a view, loaded while `active`: on first use and whenever the
 * relayed revision moves past the loaded one. A failed load is not retried until something changes.
 */
export function useWorkspaceAnnotations(client: CofluxClient, workspaceId: string, active: boolean): WorkspaceAnnotations {
  const model = annotationsModelFor(client);
  const entry = useStore(model.store, (state) => state.workspaces[workspaceId]) ?? EMPTY;
  const summaryRevision = useStore(client.store, (state) => state.annotationSummaries[workspaceId]?.revision);
  const loadedRevision = entry.revision;
  const neverLoaded = entry.annotations === null;
  useEffect(() => {
    if (!active) return;
    if (neverLoaded || (summaryRevision !== undefined && summaryRevision !== loadedRevision)) void model.refresh(workspaceId);
  }, [active, workspaceId, summaryRevision, loadedRevision, neverLoaded, model]);
  return entry;
}
