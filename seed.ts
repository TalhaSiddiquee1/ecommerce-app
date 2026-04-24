import { createClient } from "@sanity/client";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

type SanityImageField = {
  _type: "image";
  crop?: {
    _type: "sanity.imageCrop";
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  hotspot?: {
    _type: "sanity.imageHotspot";
    x?: number;
    y?: number;
    height?: number;
    width?: number;
  };
  asset?: {
    _id?: string;
    url?: string;
    originalFilename?: string;
    mimeType?: string;
  };
};

type SourceCategory = {
  _id: string;
  title?: string;
  slug?: { _type: "slug"; current?: string };
  description?: string;
};

type SourceProduct = {
  _id: string;
  name?: string;
  slug?: { _type: "slug"; current?: string };
  description?: string;
  price?: number;
  discount?: number;
  categories?: Array<{ _key?: string; _type: "reference"; _ref: string }>;
  stock?: number;
  label?: string;
  status?: "new" | "hot" | "sale";
  image?: SanityImageField;
};

type SourceSale = {
  _id: string;
  title?: string;
  description?: string;
  badge?: string;
  discountAmount?: number;
  couponCode?: string;
  validFrom?: string;
  validUntil?: string;
  isActive?: boolean;
  image?: SanityImageField;
};

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET;
const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2024-11-09";
const token = process.env.SANITY_API_TOKEN;
const sourceProjectId = "lo99o862";
const sourceDataset = "production";

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

const sourceClient = createClient({
  projectId: sourceProjectId,
  dataset: sourceDataset,
  apiVersion,
  useCdn: false,
});

const uploadedAssetRefs = new Map<string, string>();

async function uploadImageFromUrl(
  url: string,
  fallbackFileName: string,
  mimeType?: string,
) {
  try {
    const cachedRef = uploadedAssetRefs.get(url);
    if (cachedRef) {
      return {
        _type: "image" as const,
        asset: {
          _type: "reference" as const,
          _ref: cachedRef,
        },
      };
    }

    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }

    const contentType =
      mimeType || res.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await res.arrayBuffer());

    const asset = await client.assets.upload("image", bytes, {
      filename: fallbackFileName,
      contentType,
    });

    uploadedAssetRefs.set(url, asset._id);

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

async function mapImage(image?: SanityImageField) {
  const url = image?.asset?.url;
  if (!url) {
    return undefined;
  }

  const uploaded = await uploadImageFromUrl(
    url,
    image.asset?.originalFilename || "seed-image.jpg",
    image.asset?.mimeType,
  );

  if (!uploaded) {
    return undefined;
  }

  return {
    _type: "image" as const,
    asset: uploaded.asset,
    ...(image?.crop ? { crop: image.crop } : {}),
    ...(image?.hotspot ? { hotspot: image.hotspot } : {}),
  };
}

async function assertWritePermission() {
  const probeId = `seed-permission-probe-${Date.now()}`;
  await client.create({
    _id: probeId,
    _type: "category",
    title: "Seed Permission Probe",
  });
  await client.delete(probeId);
}

async function seed() {
  console.log("Checking write permission...");
  await assertWritePermission();

  console.log(
    `Fetching categories, products, and sales from source project ${sourceProjectId}...`,
  );
  const [categories, products, sales] = await Promise.all([
    sourceClient.fetch<SourceCategory[]>(
      `*[_type=="category"] | order(title asc){_id,title,slug,description}`,
    ),
    sourceClient.fetch<SourceProduct[]>(
      `*[_type=="product"] | order(name asc){
        _id,name,slug,description,price,discount,categories,stock,label,status,
        image{_type,crop,hotspot,asset->{_id,url,originalFilename,mimeType}}
      }`,
    ),
    sourceClient.fetch<SourceSale[]>(
      `*[_type=="sale"] | order(title asc){
        _id,title,description,badge,discountAmount,couponCode,validFrom,validUntil,isActive,
        image{_type,crop,hotspot,asset->{_id,url,originalFilename,mimeType}}
      }`,
    ),
  ]);

  if (!categories.length && !products.length && !sales.length) {
    throw new Error("No source data found to seed.");
  }

  console.log(
    "Clearing existing category/product/sale documents in target dataset...",
  );
  await client.delete({
    query: `*[_type in ["category","product","sale"]]._id`,
  });

  console.log(`Seeding ${categories.length} categories...`);
  for (const category of categories) {
    await client.createOrReplace({
      _id: category._id,
      _type: "category",
      ...(category.title ? { title: category.title } : {}),
      ...(category.slug ? { slug: category.slug } : {}),
      ...(category.description ? { description: category.description } : {}),
    });
  }

  console.log(`Seeding ${products.length} products with images...`);
  for (const product of products) {
    const mappedImage = await mapImage(product.image);
    await client.createOrReplace({
      _id: product._id,
      _type: "product",
      ...(product.name ? { name: product.name } : {}),
      ...(product.slug ? { slug: product.slug } : {}),
      ...(product.description ? { description: product.description } : {}),
      ...(typeof product.price === "number" ? { price: product.price } : {}),
      ...(typeof product.discount === "number"
        ? { discount: product.discount }
        : {}),
      ...(product.categories ? { categories: product.categories } : {}),
      ...(typeof product.stock === "number" ? { stock: product.stock } : {}),
      ...(product.label ? { label: product.label } : {}),
      ...(product.status ? { status: product.status } : {}),
      ...(mappedImage ? { image: mappedImage } : {}),
    });
  }

  console.log(`Seeding ${sales.length} sales with images...`);
  for (const sale of sales) {
    const mappedImage = await mapImage(sale.image);
    await client.createOrReplace({
      _id: sale._id,
      _type: "sale",
      ...(sale.title ? { title: sale.title } : {}),
      ...(sale.description ? { description: sale.description } : {}),
      ...(sale.badge ? { badge: sale.badge } : {}),
      ...(typeof sale.discountAmount === "number"
        ? { discountAmount: sale.discountAmount }
        : {}),
      ...(sale.couponCode ? { couponCode: sale.couponCode } : {}),
      ...(sale.validFrom ? { validFrom: sale.validFrom } : {}),
      ...(sale.validUntil ? { validUntil: sale.validUntil } : {}),
      ...(typeof sale.isActive === "boolean"
        ? { isActive: sale.isActive }
        : {}),
      ...(mappedImage ? { image: mappedImage } : {}),
    });
  }

  console.log(
    `Seeding complete. Imported ${categories.length} categories, ${products.length} products, and ${sales.length} sales.`,
  );
}

seed().catch((error) => {
  const statusCode = error?.statusCode;
  const permissionError =
    typeof error?.message === "string" &&
    error.message.toLowerCase().includes("insufficient permissions");
  const unauthorizedError =
    typeof error?.message === "string" &&
    error.message.toLowerCase().includes("unauthorized");

  if (statusCode === 401 || unauthorizedError) {
    console.error(
      "Seed failed: SANITY_API_TOKEN is invalid, revoked, or for a different project.",
    );
    console.error(
      "Create a new write-enabled API token in Sanity Manage for project 0g1lxd4m, update SANITY_API_TOKEN in .env, then run npm run seed again.",
    );
  } else if (statusCode === 403 || permissionError) {
    console.error("Seed failed: your Sanity token cannot create documents.");
    console.error(
      "Update SANITY_API_TOKEN in .env with a write-enabled token for this project/dataset and run npm run seed again.",
    );
  } else {
    console.error("Seed failed:", error);
  }

  process.exit(1);
});
