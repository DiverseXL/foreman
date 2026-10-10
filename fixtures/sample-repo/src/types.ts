export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  taxExempt?: boolean;
}

export interface Coupon {
  code: string;
  type: 'fixed' | 'percentage';
  value: number;
}

export interface ShippingDimensions {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
}

export interface PricingOptions {
  coupon?: Coupon;
  taxRate?: number;
  shippingOption?: 'standard' | 'express' | 'free';
  volumetricRate?: number;
  packageDimensions?: ShippingDimensions;
}

export interface PricingSummary {
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  grandTotal: number;
}
