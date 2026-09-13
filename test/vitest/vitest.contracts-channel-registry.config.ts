import {
  channelRegistryContractPatterns,
  createContractsVitestConfig,
} from "./vitest.contracts-shared.ts";

export default createContractsVitestConfig(channelRegistryContractPatterns, "contracts-channel-registry");
