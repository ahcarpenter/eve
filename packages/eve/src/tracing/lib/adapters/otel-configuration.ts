import type {
  MetricReader,
  PropagatorOrName,
  SamplerOrName,
  SpanProcessorOrName,
} from "#compiled/@vercel/otel/index.js";

/** Resolved process-wide settings. Hosts discover and merge their own declarations. */
export interface OtelConfiguration {
  readonly instrumentations?: readonly unknown[];
  readonly metricReaders?: readonly MetricReader[];
  readonly propagators?: readonly PropagatorOrName[];
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly sampler?: SamplerOrName;
  readonly spanProcessors: readonly SpanProcessorOrName[];
}
