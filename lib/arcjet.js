import arcjet, { tokenBucket } from "@arcjet/next";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  characteristics: ["ip.src"], // Track based on User IP
  rules: [
    // Rate limiting specifically for collection creation
    tokenBucket({
      mode: "LIVE",
      refillRate: 100, // 10 collections
      interval: 3600, // per hour
      capacity: 100, // maximum burst capacity
    }),
  ],
});

export default aj;
