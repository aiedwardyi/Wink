export function effectiveModelDial(config: { features?: { modelDial?: boolean } }): boolean {
  return config.features?.modelDial ?? true;
}
