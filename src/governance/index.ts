export type {
  KalmanState,
  KalmanConfig,
  TrustUpdateOutcome,
  SurpriseScore,
  FrictionSignal,
  ActionValue,
  EpistemicBoundaryType,
} from "./types";

export {
  DEFAULT_KALMAN_CONFIG,
  TRUST_RATES,
  SURPRISE_THRESHOLD,
  FRICTION_THRESHOLD,
} from "./types";

export {
  normaliseRisk,
  createKalmanState,
  kalmanUpdate,
  computeHealthObservation,
} from "./kalman-estimator";

export {
  updateTrust,
  initialTrust,
  isTrustDegraded,
} from "./trust";

export {
  normaliseActionRisk,
  initialRiskState,
  updateRisk,
  shouldEscalate,
} from "./risk";

export {
  computeSurprise,
  aggregateSurprise,
} from "./surprise";

export {
  detectFriction,
} from "./cost-friction";

export type { HorizonStep, HorizonBoundary } from "./value";
export {
  DEFAULT_DISCOUNT,
  computeActionValue,
  projectHorizon,
} from "./value";
