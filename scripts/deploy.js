const hre = require("hardhat");

async function main() {
  const EnergyTrading = await hre.ethers.getContractFactory("EnergyTrading");
  const energyTrading = await EnergyTrading.deploy();

  await energyTrading.waitForDeployment();

  console.log(`EnergyTrading deployed to: ${await energyTrading.getAddress()}`);
}

// THE FIX: We added ".then(() => process.exit(0))"
main()
  .then(() => process.exit(0)) 
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });