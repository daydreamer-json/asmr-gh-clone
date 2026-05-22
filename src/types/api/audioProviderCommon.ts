const orderNameArray = [
  'release',
  'create_date',
  'rating',
  'dl_count',
  'price',
  'rate_average_2dp',
  'review_count',
  'id',
  'nsfw',
  'random',
  'betterRandom',
] as const;
export type OrderName = (typeof orderNameArray)[number];
export { orderNameArray };
