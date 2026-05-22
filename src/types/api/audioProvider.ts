import * as Work from './audioProviderWork';

export interface AuthMeUser {
  /**
   * is user logged in
   */
  loggedIn: boolean;
  /**
   * username
   */
  name?: string;
  /**
   * user group
   */
  group?: 'user' | string;
  email?: string;
  /**
   * UUIDv4 for recommender
   */
  recommenderUuid?: string;
}

/**
 * `/auth/me` auth status
 */
export interface RspAuthMeGet {
  user: AuthMeUser;
  /**
   * is the auth system available
   */
  auth: boolean;
  /**
   * is registration available
   */
  reg: boolean;
}

/**
 * `/auth/reg` registration availability
 */
export interface RspAuthReg {
  /**
   * is registration available
   */
  reg: boolean;
}

/**
 * `/auth/me` POST login req json body
 */
export interface ReqAuthMePost {
  name: string;
  password: string;
}

/**
 * `/auth/me` POST login response
 */
export interface RspAuthMePost {
  user: AuthMeUser;
  /**
   * JWT access token
   */
  token: string;
}

/**
 * `/works` response
 */
export interface RspWorks {
  works: (Work.WorkInfoBase & { userRating: null | unknown })[];
  pagination: { currentPage: number; pageSize: number; totalCount: number };
}

/**
 * `/workInfo/:id` response
 */
export interface RspWorkInfo extends Work.WorkInfoBase {}
export interface RspWorkInfoSanitized
  extends Omit<Work.WorkInfoBase, 'samCoverUrl' | 'thumbnailCoverUrl' | 'mainCoverUrl' | 'circle_id' | 'name'> {}
