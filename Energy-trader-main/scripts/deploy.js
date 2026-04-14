/**
 * Deploy EnergyTrading to the connected network.
 * Default Hardhat account #0 becomes the on-chain oracle (see contract constructor).
 * Copy the printed address into .env as CONTRACT_ADDRESS=
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const EnergyTrading = await hre.ethers.getContractFactory("EnergyTrading");
  const et = await EnergyTrading.deploy();
  await et.waitForDeployment();
  const address = await et.getAddress();
  console.log("Deployer (oracle):", deployer.address);
  console.log("EnergyTrading:", address);
  console.log("");
  console.log("Add to your .env file:");
  console.log(`CONTRACT_ADDRESS=${address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
