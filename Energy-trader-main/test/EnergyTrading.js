const { expect } = require("chai");
const hre = require("hardhat");

describe("EnergyTrading", function () {
  async function deployFixture() {
    const [oracle, stranger] = await hre.ethers.getSigners();
    const EnergyTrading = await hre.ethers.getContractFactory("EnergyTrading");
    const et = await EnergyTrading.connect(oracle).deploy();
    await et.waitForDeployment();
    return { et, oracle, stranger };
  }

  it("lets the oracle submit a batch when msg.value matches _totalValue and emits BatchVerified", async function () {
    const { et, oracle } = await deployFixture();
    const root = hre.ethers.zeroPadValue("0xabcd", 32);
    const count = 5n;
    const value = 400n;

    await expect(et.connect(oracle).submitBatch(root, count, value, { value: value }))
      .to.emit(et, "BatchVerified")
      .withArgs(0n, root, count, value);

    const header = await et.batches(0n);
    expect(header.merkleRoot).to.equal(root);
    expect(header.tradeCount).to.equal(count);
    expect(header.totalValue).to.equal(value);
  });

  it('reverts with "Only Oracle" when a non-oracle submits', async function () {
    const { et, stranger } = await deployFixture();
    const root = hre.ethers.ZeroHash;
    await expect(
      et.connect(stranger).submitBatch(root, 1n, 0n, { value: 0n })
    ).to.be.revertedWith("Only Oracle");
  });

  it('reverts with "ETH Sent mismatch" when value does not match', async function () {
    const { et, oracle } = await deployFixture();
    const root = hre.ethers.ZeroHash;
    await expect(
      et.connect(oracle).submitBatch(root, 2n, 100n, { value: 50n })
    ).to.be.revertedWith("ETH Sent mismatch");
  });
});
