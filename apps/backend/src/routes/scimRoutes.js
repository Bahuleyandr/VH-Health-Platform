import express from 'express';

import {
  createUser,
  getGroups,
  getServiceProviderConfig,
  getUser,
  getUsers,
  removeUser,
  replaceUser,
  updateUser,
} from '../controllers/auth/scimController.js';

const router = express.Router();

router.get('/:tenantSlug/:providerKey/ServiceProviderConfig', getServiceProviderConfig);
router.get('/:tenantSlug/:providerKey/Groups', getGroups);
router.get('/:tenantSlug/:providerKey/Users', getUsers);
router.post('/:tenantSlug/:providerKey/Users', createUser);
router.get('/:tenantSlug/:providerKey/Users/:id', getUser);
router.put('/:tenantSlug/:providerKey/Users/:id', replaceUser);
router.patch('/:tenantSlug/:providerKey/Users/:id', updateUser);
router.delete('/:tenantSlug/:providerKey/Users/:id', removeUser);

export default router;
