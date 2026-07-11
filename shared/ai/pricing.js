export function calculateCost(totalTokens, markupCoins) {
  return totalTokens + markupCoins;
}

export function calculateImageCost(imageBaseCost, markupCoins) {
  return (imageBaseCost || 500) + markupCoins;
}
