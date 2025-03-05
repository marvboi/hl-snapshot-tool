import React, { useState, useEffect } from 'react';
import { Download, RefreshCw, FileText, Coins } from 'lucide-react';
import { ethers } from 'ethers';
import pLimit from 'p-limit';

// Extended ABI to handle different implementations
const ERC721_ABI = [
  // Basic ERC721 functions
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)',
  
  // ERC721Enumerable functions (not all contracts implement these)
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  
  // Events for fallback method
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

// Interface for holder data with token details
interface HolderData {
  address: string;
  tokenCount: number;
  tokenIds: string[];
}

function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [displayText, setDisplayText] = useState('');
  const [authorText, setAuthorText] = useState('');
  const [contractAddress, setContractAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [showDetailed, setShowDetailed] = useState(false);
  const [showDonation, setShowDonation] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  useEffect(() => {
    const text = "Snapshot Tool";
    const author = "by Marvreum";
    let currentIndex = 0;
    let authorShown = false;
    
    const randomChar = () => {
      const chars = "!@#$%^&*()_+-=[]{}|;:,.<>?";
      return chars[Math.floor(Math.random() * chars.length)];
    };
    
    const typeWriter = setInterval(() => {
      if (currentIndex <= text.length) {
        setDisplayText(text.slice(0, currentIndex));
        currentIndex++;
      } else if (!authorShown) {
        let scrambledAuthor = '';
        for (let i = 0; i < author.length; i++) {
          scrambledAuthor += randomChar();
        }
        setAuthorText(scrambledAuthor);
        
        setTimeout(() => {
          setAuthorText(author);
          authorShown = true;
        }, 500);
      }
    }, 100);
    
    setTimeout(() => {
      clearInterval(typeWriter);
      setIsLoading(false);
    }, 5000);
    
    return () => clearInterval(typeWriter);
  }, []);

  const handleCopyAddress = async () => {
    try {
      await navigator.clipboard.writeText('0x25BB190Da7F60E00bf26587cd12F0B3448B6d5d7');
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy address:', err);
    }
  };

  // Utility function to retry API calls with backoff
  const retryWithBackoff = async (
    fn: () => Promise<any>, 
    maxRetries: number = 3, 
    initialDelay: number = 1000
  ): Promise<any> => {
    let retries = 0;
    while (true) {
      try {
        return await fn();
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          throw error;
        }
        // Exponential backoff
        const delay = initialDelay * Math.pow(2, retries - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };

  const downloadCSV = (data: string[], filename: string) => {
    // Convert array to CSV string manually
    const csvContent = data.map(row => row.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  // Generate two CSV files - one with just holders and counts, one with token details
  const generateCSVs = (holders: Map<string, HolderData>, name: string, symbol: string) => {
    // Simple CSV with just holders and counts
    const simpleData = [
      ['Wallet Address', 'Token Count'], // Header
      ...Array.from(holders.values()).map(holder => [holder.address, holder.tokenCount.toString()])
    ];
    
    // Detailed CSV with token IDs
    const detailedData = [
      ['Wallet Address', 'Token Count', 'Token IDs'], // Header
      ...Array.from(holders.values()).map(holder => [
        holder.address,
        holder.tokenCount.toString(),
        `"${holder.tokenIds.join(', ')}"`
      ])
    ];

    const date = new Date().toISOString().split('T')[0];
    
    // Download both files
    downloadCSV(simpleData, `${symbol}_holders_summary_${date}.csv`);
    
    if (showDetailed) {
      downloadCSV(detailedData, `${symbol}_holders_detailed_${date}.csv`);
    }
    
    return [simpleData.length - 1, detailedData.length - 1]; // Count without header
  };

  // Check if contract supports ERC721Enumerable
  const supportsEnumeration = async (contract: ethers.Contract): Promise<boolean> => {
    try {
      await contract.totalSupply();
      
      // Try to get a token - if this fails, enumeration isn't fully supported
      const testTokenId = await contract.tokenByIndex(0);
      await contract.ownerOf(testTokenId);
      
      return true;
    } catch (err) {
      console.log("Contract does not support enumeration fully:", err);
      return false;
    }
  };
  
  // Optimized method to get holders with token IDs using batch RPC requests
  const getHoldersWithBatching = async (contract: ethers.Contract, totalSupply: number): Promise<Map<string, HolderData>> => {
    setStatusMessage(`Optimized fetching for ${totalSupply} tokens...`);
    
    // Create a concurrent request limit to avoid overloading the RPC
    const limit = pLimit(10); // Process 10 requests concurrently (reduced from 25)
    const holderData = new Map<string, HolderData>();
    
    // Create batches of token indices to process
    const batchSize = 50; // Reduced from 100 to prevent overloading
    const batches = [];
    
    for (let i = 0; i < totalSupply; i += batchSize) {
      batches.push(Array.from(
        { length: Math.min(batchSize, totalSupply - i) },
        (_, j) => i + j
      ));
    }
    
    let processedTokens = 0;
    
    // Process each batch
    for (const [batchIndex, batch] of batches.entries()) {
      setStatusMessage(`Processing batch ${batchIndex + 1}/${batches.length}...`);
      
      // Create promises for each token in the batch
      const promises = batch.map(index => limit(async () => {
        try {
          // Use retry mechanism for each token operation
          const tokenId = await retryWithBackoff(() => contract.tokenByIndex(index));
          const owner = await retryWithBackoff(() => contract.ownerOf(tokenId));
          
          // Convert tokenId to string
          const tokenIdStr = tokenId.toString();
          
          // Update or create holder data
          if (holderData.has(owner)) {
            const data = holderData.get(owner)!;
            data.tokenCount++;
            data.tokenIds.push(tokenIdStr);
          } else {
            holderData.set(owner, {
              address: owner,
              tokenCount: 1,
              tokenIds: [tokenIdStr]
            });
          }
          
          return { success: true };
        } catch (err) {
          return { success: false, error: err };
        }
      }));
      
      // Wait for all promises in this batch to resolve
      await Promise.all(promises);
      
      // Update progress
      processedTokens += batch.length;
      setProgress(Math.floor(processedTokens * 100 / totalSupply));
    }
    
    return holderData;
  };
  
  // Fallback method: Scan for Transfer events to determine current owners with token IDs
  const getHoldersFromEvents = async (contract: ethers.Contract, provider: ethers.JsonRpcProvider): Promise<Map<string, HolderData>> => {
    setStatusMessage('Using Transfer events to determine holders...');
    
    try {
      // Get current block number with retry
      const currentBlock = await retryWithBackoff(() => provider.getBlockNumber());
      
      // Use a more conservative block range to avoid timeouts
      const blockRange = 50000; // Reduced from 100000
      const startBlock = Math.max(0, currentBlock - blockRange);
      
      setStatusMessage(`Scanning events from block ${startBlock} to ${currentBlock}...`);
      
      // Create a filter for Transfer events
      const filter = contract.filters.Transfer();
      
      // Get all transfer events in chunks to avoid timeouts
      const chunkSize = 5000; // Reduced from 10000
      const eventChunks = [];
      
      // Process blocks in parallel with limits
      const limit = pLimit(3); // Reduced from 5
      const blockChunks = [];
      
      for (let fromBlock = startBlock; fromBlock < currentBlock; fromBlock += chunkSize) {
        const toBlock = Math.min(currentBlock, fromBlock + chunkSize - 1);
        blockChunks.push({ fromBlock, toBlock });
      }
      
      // Initialize tracking map before processing
      const tokenOwners = new Map<string, string>();
      
      // Process each block chunk sequentially to avoid overwhelming the RPC
      for (const [index, { fromBlock, toBlock }] of blockChunks.entries()) {
        setStatusMessage(`Scanning chunk ${index + 1}/${blockChunks.length}: blocks ${fromBlock}-${toBlock}...`);
        
        try {
          // Use retry mechanism with timeout for event fetching
          const events = await retryWithBackoff(
            async () => {
              try {
                return await contract.queryFilter(filter, fromBlock, toBlock);
              } catch (err: any) {
                // Check for JSON parsing errors
                if (err?.code === 'UNSUPPORTED_OPERATION' && err?.operation === 'bodyJson') {
                  // For JSON parsing errors, use a more conservative approach with smaller chunks
                  console.log("JSON parsing error detected, trying smaller chunk...");
                  
                  // Split the chunk in half and try again
                  const midBlock = Math.floor((fromBlock + toBlock) / 2);
                  
                  // Try the first half
                  let allEvents = [];
                  try {
                    const events1 = await contract.queryFilter(filter, fromBlock, midBlock);
                    allEvents = [...events1];
                  } catch (err1) {
                    console.log(`Error on first half (${fromBlock}-${midBlock}):`, err1);
                  }
                  
                  // Try the second half
                  try {
                    const events2 = await contract.queryFilter(filter, midBlock + 1, toBlock);
                    allEvents = [...allEvents, ...events2];
                  } catch (err2) {
                    console.log(`Error on second half (${midBlock+1}-${toBlock}):`, err2);
                  }
                  
                  return allEvents;
                }
                throw err; // Re-throw other types of errors
              }
            }
          );
          
          // Process events in this chunk
          for (const event of events) {
            try {
              // @ts-ignore - We know these properties exist in the event
              const { from, to, tokenId } = event.args!;
              
              // Convert BigInt tokenId to string for Map keys
              const tokenIdString = tokenId.toString();
              
              // Track current owner (to is the new owner)
              tokenOwners.set(tokenIdString, to);
            } catch (err) {
              // Skip event if we can't process it
              continue;
            }
          }
          
          // Update progress
          setProgress(Math.floor((index + 1) * 100 / blockChunks.length));
          
        } catch (err) {
          console.log(`Error scanning blocks ${fromBlock}-${toBlock}:`, err);
          // Continue to next chunk even if this one fails
        }
      }
      
      setStatusMessage(`Found owner data for ${tokenOwners.size} tokens. Processing...`);
      
      // Convert to holders map with token IDs
      const holders = new Map<string, HolderData>();
      
      // Group tokens by owner
      for (const [tokenId, owner] of tokenOwners.entries()) {
        if (holders.has(owner)) {
          const holderData = holders.get(owner)!;
          holderData.tokenCount++;
          holderData.tokenIds.push(tokenId);
        } else {
          holders.set(owner, {
            address: owner,
            tokenCount: 1,
            tokenIds: [tokenId]
          });
        }
      }
      
      if (holders.size === 0) {
        throw new Error("No holders found from transfer events");
      }
      
      return holders;
    } catch (err) {
      console.error("Error using events method:", err);
      throw new Error("Failed to get transfer events. The RPC endpoint may be rate limiting requests.");
    }
  };

  // Try to get token owners directly by querying a reasonable range of token IDs
  const getHoldersByTokenRange = async (contract: ethers.Contract): Promise<Map<string, HolderData>> => {
    setStatusMessage('Querying token owners by ID range...');
    
    const holders = new Map<string, HolderData>();
    const maxTokensToCheck = 10000; // Reduced from 20000 to prevent overwhelming the RPC
    let foundTokens = 0;
    
    // Create concurrent request limit
    const limit = pLimit(20); // Reduced from 50
    
    // Process token IDs in batches for better performance
    const batchSize = 200; // Reduced from 500
    const batches = [];
    
    for (let i = 0; i < maxTokensToCheck; i += batchSize) {
      batches.push(Array.from(
        { length: Math.min(batchSize, maxTokensToCheck - i) },
        (_, j) => i + j
      ));
    }
    
    for (const [batchIndex, batch] of batches.entries()) {
      // Create and execute promises for each token ID in the batch
      const promises = batch.map(tokenId => limit(async () => {
        try {
          // Use retry mechanism for each token query
          const owner = await retryWithBackoff(() => contract.ownerOf(tokenId));
          
          // Update holders map
          if (holders.has(owner)) {
            const holderData = holders.get(owner)!;
            holderData.tokenCount++;
            holderData.tokenIds.push(tokenId.toString());
          } else {
            holders.set(owner, {
              address: owner,
              tokenCount: 1,
              tokenIds: [tokenId.toString()]
            });
          }
          
          return { found: true, tokenId };
        } catch (err) {
          return { found: false, tokenId };
        }
      }));
      
      // Wait for all promises in the batch to resolve
      const results = await Promise.all(promises);
      
      // Count found tokens
      const newlyFound = results.filter(r => r.found).length;
      foundTokens += newlyFound;
      
      // Update progress and status
      setProgress(Math.floor((batchIndex + 1) * 100 / batches.length));
      setStatusMessage(`Processed ${(batchIndex + 1) * batchSize} IDs, found ${foundTokens} tokens so far...`);
      
      // If we found very few tokens in this batch, we might be at the end of the collection
      if (newlyFound < batchSize * 0.01 && batchIndex > 3) {
        setStatusMessage(`Low token density detected. Stopping scan at ID ${batch[batch.length - 1]}`);
        break;
      }
    }
    
    if (foundTokens === 0) {
      throw new Error('No tokens found in the ID range');
    }
    
    setStatusMessage(`Found ${foundTokens} tokens across ${holders.size} holders`);
    return holders;
  };

  const handleSnapshot = async () => {
    setLoading(true);
    setError('');
    setProgress(0);
    setStatusMessage('');
    
    try {
      // Connect to HyperEVM with timeout and retry
      const provider = new ethers.JsonRpcProvider('https://rpc.hyperliquid.xyz/evm', undefined, {
        staticNetwork: true,
        timeout: 30000, // 30 second timeout
        polling: true,
        batchStallTime: 50 // ms to wait to batch provider requests
      });
      
      const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);

      // Get collection info with better error handling
      let name, symbol;
      try {
        name = await retryWithBackoff(() => contract.name());
        symbol = await retryWithBackoff(() => contract.symbol());
        setStatusMessage(`Connected to collection: ${name} (${symbol})`);
      } catch (err) {
        console.error('Error getting collection info:', err);
        setStatusMessage('Unable to retrieve collection name/symbol. Continuing with fallback names...');
        name = 'Unknown';
        symbol = 'UNKNOWN';
      }
      
      // Try to get holders using different methods
      let holders = new Map<string, HolderData>();
      let methodsUsed = [];
      
      // First check if the contract supports enumeration
      let hasEnumeration = false;
      try {
        hasEnumeration = await supportsEnumeration(contract);
      } catch (err) {
        console.error("Error checking enumeration support:", err);
        hasEnumeration = false;
      }
      
      if (hasEnumeration) {
        try {
          // Use optimized batch processing with ERC721Enumerable methods
          setStatusMessage('Contract supports enumeration. Using optimized fetching...');
          methodsUsed.push("enumeration");
          
          // Get total supply
          const totalSupply = await retryWithBackoff(() => contract.totalSupply());
          const totalTokens = Number(totalSupply);
          
          if (totalTokens === 0) {
            throw new Error('No tokens found in this collection');
          }
          
          setStatusMessage(`Collection has ${totalTokens} tokens. Fetching with batching...`);
          
          // Use optimized batching method
          holders = await getHoldersWithBatching(contract, totalTokens);
          
        } catch (err) {
          console.log('Error using enumeration methods:', err);
          // Fall through to alternative methods
        }
      } else {
        setStatusMessage('Contract does not support enumeration. Trying alternative methods...');
      }
      
      // If we didn't get any holders with enumeration, try direct token ID queries
      if (holders.size === 0) {
        try {
          setStatusMessage('Trying optimized direct token ID queries...');
          methodsUsed.push("direct queries");
          holders = await getHoldersByTokenRange(contract);
        } catch (err) {
          console.log('Error using direct token ID queries:', err);
          // Fall through to events method
        }
      }
      
      // If we still don't have holders, try the events method
      if (holders.size === 0) {
        try {
          setStatusMessage('Trying optimized transfer events method...');
          methodsUsed.push("transfer events");
          holders = await getHoldersFromEvents(contract, provider);
        } catch (err) {
          console.error('Error using events method:', err);
          throw new Error('Failed to retrieve token holders. This contract may not be a standard ERC721 or the RPC endpoint may be rate limiting requests.');
        }
      }
      
      // Verify we have holder data
      if (holders.size === 0) {
        throw new Error('No holder data could be retrieved after trying multiple methods');
      }
      
      setStatusMessage(`Found ${holders.size} unique holders using ${methodsUsed.join(", ")}. Generating CSV files...`);
      
      // Generate and download CSVs
      const [simpleCount, detailedCount] = generateCSVs(holders, name || 'Unknown', symbol || 'UNKNOWN');
      
      setStatusMessage(`Successfully generated snapshot with ${simpleCount} holders and ${Array.from(holders.values()).reduce((sum, h) => sum + h.tokenCount, 0)} tokens!`);

    } catch (err) {
      console.error('Snapshot error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred while fetching NFT data. Please try again later or try a different contract address.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#072722] text-white flex flex-col">
      {isLoading && (
        <div className="fixed inset-0 bg-[#072722] flex flex-col items-center justify-center z-50">
          <div className="text-4xl font-mono text-[#96fce4]" style={{ fontFamily: "'Press Start 2P', cursive" }}>
            <span className="inline-block animate-flicker">{displayText}</span>
          </div>
          {authorText && (
            <div className="mt-4 text-xl text-[#96fce4] opacity-70" style={{ fontFamily: "'Press Start 2P', cursive" }}>
              {authorText}
            </div>
          )}
        </div>
      )}

      {/* Top divider line */}
      <div className="w-full h-px bg-[#96fce4]/30"></div>

      {/* Donation Button */}
      <div className="fixed top-4 right-4 z-50">
        <button
          onClick={() => setShowDonation(!showDonation)}
          className={`p-2 rounded-full bg-[#96fce4] hover:bg-[#7cdcc4] transition-all duration-300 ${showDonation ? 'animate-shake' : 'hover:animate-shake'}`}
        >
          <Coins className="w-6 h-6 text-[#072722]" />
        </button>
        
        {showDonation && (
          <div className="absolute right-0 top-full mt-2 p-4 bg-[#0a302a] rounded-lg shadow-xl border border-[#96fce4] w-72">
            <p className="text-[#96fce4] mb-2">For this amazing tool, you can donate to Marvreum!</p>
            <button
              onClick={handleCopyAddress}
              className="w-full text-sm font-mono bg-[#072722] p-2 rounded break-all hover:bg-[#0a3830] transition-colors duration-200 text-left relative"
            >
              0x25BB190Da7F60E00bf26587cd12F0B3448B6d5d7
              {copySuccess && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[#96fce4] text-xs">
                  Copied!
                </span>
              )}
            </button>
          </div>
        )}
      </div>
      
      <div className="container mx-auto px-4 flex-grow flex items-center justify-center">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-bold mb-8 text-[#96fce4]" style={{ fontFamily: "'Press Start 2P', cursive" }}>
            NFT Holder Snapshot Tool
          </h1>
          
          <div className="bg-[#0a302a] p-6 rounded-lg shadow-xl">
            <div className="mb-6">
              <label 
                htmlFor="contract" 
                className="block text-[#96fce4] mb-2 font-medium"
              >
                HyperEvm NFT Contract Address
              </label>
              <input
                id="contract"
                type="text"
                className="w-full px-4 py-2 rounded bg-[#072722] border border-[#96fce4] text-white focus:outline-none focus:ring-2 focus:ring-[#96fce4]"
                placeholder="Enter ERC-721 contract address"
                value={contractAddress}
                onChange={(e) => setContractAddress(e.target.value)}
              />
              
              <div className="mt-3 flex items-center">
                <input
                  id="detailed"
                  type="checkbox"
                  className="mr-2 h-4 w-4 rounded border-[#96fce4] text-[#96fce4] focus:ring-[#96fce4]"
                  checked={showDetailed}
                  onChange={(e) => setShowDetailed(e.target.checked)}
                />
                <label htmlFor="detailed" className="text-sm text-[#96fce4]">
                  Include detailed CSV with token IDs
                </label>
              </div>
            </div>

            <div className="flex flex-col items-center gap-4">
              <button
                onClick={handleSnapshot}
                disabled={loading || !contractAddress}
                className={`
                  flex items-center justify-center px-6 py-3 rounded w-full
                  ${loading || !contractAddress 
                    ? 'bg-gray-600 cursor-not-allowed' 
                    : 'bg-[#96fce4] hover:bg-[#7cdcc4] text-[#072722]'}
                  font-medium transition-colors duration-200
                `}
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-5 h-5 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <FileText className="w-5 h-5 mr-2" />
                    Generate Snapshot
                  </>
                )}
              </button>

              {loading && progress > 0 && (
                <div className="w-full mt-4">
                  <div className="h-2 bg-[#072722] rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-[#96fce4] transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <p className="text-center mt-2 text-[#96fce4]">{progress}% Complete</p>
                </div>
              )}
              
              {statusMessage && (
                <div className="w-full mt-2 p-3 bg-[#0d3a35] rounded text-[#96fce4] text-sm">
                  {statusMessage}
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-red-500/20 border border-red-500 rounded text-red-300">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Bottom divider line */}
      <div className="w-full h-px bg-[#96fce4]/30"></div>
      
      {/* Transparent footer with Marvreum link - Updated with larger text and glow effect */}
      <footer className="w-full py-4 text-center text-white/70 text-lg bg-transparent">
        Made with 💚 <a 
          href="https://x.com/Marvreum" 
          target="_blank" 
          rel="noopener noreferrer" 
          className="font-medium text-[#96fce4] hover:text-white transition-colors"
          style={{ 
            textShadow: '0 0 8px rgba(150, 252, 228, 0.7), 0 0 12px rgba(150, 252, 228, 0.4)'
          }}
        >
          Marvreum
        </a>
      </footer>
    </div>
  );
}

export default App;