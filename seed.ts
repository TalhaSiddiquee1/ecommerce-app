import { createClient } from "@sanity/client";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

type FakeStoreProduct = {
  id: number;
  title: string;
  price: number;
  description: string;
  category: string;
  image: string;
};

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET;
const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2024-11-09";
const token = process.env.SANITY_API_TOKEN;

if (!projectId || !dataset || !token) {
  throw new Error(
    "Missing required env vars. Ensure NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET, and SANITY_API_TOKEN are set.",
  );
}

const client = createClient({
  projectId,
  dataset,
  apiVersion,
  token,
  useCdn: false,
});

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

async function uploadImageFromUrl(url: string, fallbackFileName: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await res.arrayBuffer());

    const asset = await client.assets.upload("image", bytes, {
      filename: fallbackFileName,
      contentType,
    });

    return {
      _type: "image" as const,
      asset: {
        _type: "reference" as const,
        _ref: asset._id,
      },
    };
  } catch {
    return null;
  }
}

async function seed() {
  console.log("Fetching products from Fake Store API...");
  const response = await fetch("https://fakestoreapi.com/products");

  if (!response.ok) {
    throw new Error(
      `Failed to fetch products: ${response.status} ${response.statusText}`,
    );
  }

  const products = (await response.json()) as FakeStoreProduct[];

  if (!Array.isArray(products) || products.length === 0) {
    throw new Error("No products returned from API.");
  }

  const categoryMap = new Map<string, string>();

  for (const product of products) {
    const categorySlug = slugify(product.category);
    const categoryId = `category-${categorySlug}`;

    if (!categoryMap.has(product.category)) {
      await client.createOrReplace({
        _id: categoryId,
        _type: "category",
        title: product.category,
        slug: {
          _type: "slug",
          current: categorySlug,
        },
        description: `Seeded category for ${product.category}`,
      });
      categoryMap.set(product.category, categoryId);
    }
  }

  console.log(`Seeded ${categoryMap.size} categories.`);

  let seededCount = 0;

  for (const product of products) {
    const categoryId = categoryMap.get(product.category);
    if (!categoryId) {
      continue;
    }

    const productId = `product-fakestore-${product.id}`;
    const productSlug = slugify(product.title);

    const image = await uploadImageFromUrl(product.image, `${productSlug}.jpg`);

    await client.createOrReplace({
      _id: productId,
      _type: "product",
      name: product.title,
      slug: {
        _type: "slug",
        current: productSlug,
      },
      description: product.description,
      price: Number(product.price.toFixed(2)),
      discount: 0,
      stock: 25,
      label: "Featured",
      status:
        seededCount % 3 === 0 ? "new" : seededCount % 3 === 1 ? "hot" : "sale",
      categories: [
        {
          _key: `cat-${categoryId}`,
          _type: "reference",
          _ref: categoryId,
        },
      ],
      ...(image ? { image } : {}),
    });

    seededCount += 1;
  }

  console.log(`Seeded ${seededCount} products.`);
  console.log("Seeding complete.");
}

seed().catch((error) => {
  const statusCode = error?.statusCode;
  const permissionError =
    typeof error?.message === "string" &&
    error.message.toLowerCase().includes("insufficient permissions");

  if (statusCode === 403 || permissionError) {
    console.error("Seed failed: your Sanity token cannot create documents.");
    console.error(
      "Update SANITY_API_TOKEN in .env with a write-enabled token for this project/dataset and run npm run seed again.",
    );
  } else {
    console.error("Seed failed:", error);
  }

  process.exit(1);
});
