// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract EnergyTrading {
    struct BatchHeader {
        bytes32 merkleRoot;
        uint256 timestamp;
        uint256 tradeCount;
        uint256 totalValue; // New: Stores the $ value of the batch
    }

    BatchHeader[] public batches;
    address public oracle;

    // New: Event now logs the Value ($)
    event BatchVerified(uint256 indexed batchId, bytes32 merkleRoot, uint256 count, uint256 value);

    constructor() {
        oracle = msg.sender;
    }

    // UPDATE: "payable" allows this function to accept Real ETH
    function submitBatch(bytes32 _merkleRoot, uint256 _tradeCount, uint256 _totalValue) public payable {
        require(msg.sender == oracle, "Only Oracle");

        // We verify that the ETH sent matches the batch value (1 Wei = $1 for demo)
        require(msg.value == _totalValue, "ETH Sent mismatch");

        batches.push(BatchHeader({
            merkleRoot: _merkleRoot,
            timestamp: block.timestamp,
            tradeCount: _tradeCount,
            totalValue: _totalValue
        }));

        emit BatchVerified(batches.length - 1, _merkleRoot, _tradeCount, _totalValue);
    }
}