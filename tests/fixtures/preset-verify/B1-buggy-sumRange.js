function sumRange(arr, start, end) {
  return arr.slice(start, end + 1).reduce((a,b)=>a+b, 0);
}
sumRange([1,2,3,4,5], 1, 3); // 想算 idx 1 到 3 含端點 = 2+3+4 = 9，回 9 ✓
