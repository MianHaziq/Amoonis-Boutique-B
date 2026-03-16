const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

/**
 * Verify JWT token middleware
 * Extracts user/admin from token and attaches to request
 */
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.userRole = decoded.role;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please login again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.',
      });
    }

    next(error);
  }
};

/**
 * Verify admin token middleware
 * Checks if the token belongs to a user with ADMIN role
 */
const verifyAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if user exists and has ADMIN role
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user || user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.',
      });
    }

    req.userId = decoded.id;
    req.user = user;
    req.isAdmin = true;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please login again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.',
      });
    }

    next(error);
  }
};

/**
 * Verify instructor or admin middleware
 * Allows access for instructors and admins
 */
const verifyInstructorOrAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check user exists and has appropriate role
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. User not found.',
      });
    }

    if (user.role === 'ADMIN') {
      req.userId = decoded.id;
      req.user = user;
      req.isAdmin = true;
      return next();
    }

    if (user.role === 'INSTRUCTOR') {
      req.userId = decoded.id;
      req.user = user;
      req.isInstructor = true;
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Access denied. Instructor or Admin privileges required.',
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please login again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.',
      });
    }

    next(error);
  }
};

module.exports = {
  verifyToken,
  verifyAdmin,
  verifyInstructorOrAdmin,
};
