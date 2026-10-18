export class RebateScaleNotFoundError extends Error {
  constructor(message = "No rebate scale is configured for this party.") {
    super(message);
    this.name = "RebateScaleNotFoundError";
  }
}

export class InvalidRebateScaleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRebateScaleInputError";
  }
}
